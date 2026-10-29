using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewaySyncResult
    {
        public bool Changed { get; set; }
        public int Revision { get; set; }
        public List<GatewayRouteReport> Routes { get; set; }
    }

    internal sealed class GatewayControlPlaneClient
    {
        private const int ProbeTimeoutMilliseconds = 5000;
        private readonly GatewayConfigurationStore _store;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        public GatewayControlPlaneClient(GatewayConfigurationStore store) { _store = store; }

        public GatewayEnrollmentResponse Enroll(string installCode, string version, string clientName)
        {
            var current = _store.Load();
            var url = current.ApiBaseUrl.TrimEnd('/') + "/external-access-agent/enroll";
            var request = _json.Serialize(new { installCode = (installCode ?? "").Trim().ToUpperInvariant(), computerName = Environment.MachineName, clientName = (clientName ?? "").Trim(), version = version });
            using (var client = NewClient(false))
            {
                client.Headers[HttpRequestHeader.ContentType] = "application/json";
                string raw;
                try { raw = client.UploadString(url, "POST", request); }
                catch (WebException exception) { throw FriendlyRemoteError(exception); }
                var response = _json.Deserialize<GatewayEnrollmentResponse>(raw);
                _store.SaveEnrollment(response);
                return response;
            }
        }

        public GatewaySyncResult Synchronize()
        {
            var current = _store.Load();
            if (!_store.IsManaged) return new GatewaySyncResult { Changed = false, Revision = current.AppliedRevision, Routes = Probe(current.Routes) };
            string response;
            using (var client = NewClient(true))
            {
                try { response = client.DownloadString(current.ApiBaseUrl.TrimEnd('/') + "/external-access-agent/configuration"); }
                catch (WebException exception) { ThrowIfRemoved(exception); throw; }
            }
            var envelope = _json.Deserialize<GatewayConfigurationEnvelope>(response);
            if (envelope == null || String.IsNullOrWhiteSpace(envelope.Configuration) || String.IsNullOrWhiteSpace(envelope.Signature))
                throw new InvalidOperationException("服务器返回的配置不完整");
            var token = _store.ReadDeviceToken();
            if (!FixedEquals(Sign(envelope.Configuration, token), envelope.Signature))
                throw new InvalidOperationException("配置签名校验失败，已拒绝应用");
            var managed = _json.Deserialize<ManagedGatewayConfiguration>(envelope.Configuration);
            DateTimeOffset expires;
            if (managed == null || managed.DeviceId != current.DeviceId || !DateTimeOffset.TryParse(managed.ExpiresAt, out expires) || expires <= DateTimeOffset.UtcNow)
                throw new InvalidOperationException("配置已过期或不属于这台电脑");
            var routes = (managed.Routes ?? new List<ManagedGatewayRoute>()).Select(route => new GatewayRoute
            {
                AppId = route.AppId,
                Id = route.Id,
                Name = route.Name,
                PublicHostname = route.PublicHostname,
                LocalUrl = route.LocalUrl,
                RemotePort = route.RemotePort,
                Enabled = route.Enabled
            }).ToList();
            // 探测结果只是各应用此刻的健康状态，不是配置是否有效。一条内网服务停机
            // 不能阻断整份配置落盘，否则其余健康的应用会跟着一起断线。
            var reports = Probe(routes);
            if (managed.Revision <= current.AppliedRevision)
                return new GatewaySyncResult { Changed = false, Revision = current.AppliedRevision, Routes = reports };
            current.ServerAddress = managed.ServerAddress;
            current.ServerPort = managed.ServerPort;
            current.Routes = routes;
            current.AppliedRevision = managed.Revision;
            _store.Save(current);
            return new GatewaySyncResult { Changed = true, Revision = managed.Revision, Routes = reports };
        }

        /** 用户主动点击的单条测试：只从本机访问目标地址，不会修改 PMS 或隧道配置。
            走 ProbeOne 而不是 Probe，因为 Probe 会跳过停用的应用——而「内网服务修好了吗」
            正是停用期间最需要点的一次测试。 */
        public GatewayRouteReport TestRoute(GatewayRoute route)
        {
            if (route == null) throw new ArgumentNullException("route");
            var report = ProbeOne(route); report.Id = route.Id; return report;
        }

        public void Heartbeat(bool processRunning, int appliedRevision, IEnumerable<GatewayRouteReport> routes, string error)
        {
            if (!_store.IsManaged) return;
            var current = _store.Load();
            var request = BuildHeartbeatJson(
                System.Reflection.Assembly.GetExecutingAssembly().GetName().Version.ToString(3),
                processRunning,
                appliedRevision,
                routes,
                error);
            using (var client = NewClient(true))
            {
                client.Headers[HttpRequestHeader.ContentType] = "application/json";
                try { client.UploadString(current.ApiBaseUrl.TrimEnd('/') + "/external-access-agent/heartbeat", "POST", request); }
                catch (WebException exception) { ThrowIfRemoved(exception); throw; }
            }
        }

        internal static string BuildHeartbeatJson(string version, bool processRunning, int appliedRevision, IEnumerable<GatewayRouteReport> routes, string error)
        {
            // JavaScriptSerializer writes C# class properties as PascalCase. The PMS
            // DTO is strict and expects lower camelCase, so project every route into
            // an anonymous wire object instead of serializing GatewayRouteReport.
            var wireRoutes = (routes ?? Enumerable.Empty<GatewayRouteReport>()).Select(route => new
            {
                appId = route.AppId,
                healthy = route.Healthy,
                message = String.IsNullOrWhiteSpace(route.Message) ? null : route.Message
            }).ToArray();
            return new JavaScriptSerializer().Serialize(new
            {
                version = version,
                appliedRevision = appliedRevision,
                processRunning = processRunning,
                error = String.IsNullOrWhiteSpace(error) ? null : error,
                routes = wireRoutes
            });
        }

        private WebClient NewClient(bool authenticated)
        {
            var client = new TimedWebClient(); client.Encoding = Encoding.UTF8; client.Headers[HttpRequestHeader.UserAgent] = "PMS-Lan-Gateway-Assistant";
            if (authenticated)
            {
                var config = _store.Load(); client.Headers["X-Agent-Id"] = config.DeviceId; client.Headers[HttpRequestHeader.Authorization] = "Bearer " + _store.ReadDeviceToken();
            }
            return client;
        }

        /** 410 = PMS 网页已删除这台客户端（或已在别的电脑上重新配对）。403 停用不算，停用只是暂停。 */
        private void ThrowIfRemoved(WebException exception)
        {
            var response = exception.Response as HttpWebResponse;
            if (response == null || (int)response.StatusCode != 410) return;
            var friendly = FriendlyRemoteError(exception).Message;
            var colon = friendly.IndexOf('：');
            throw new GatewayRemovedException(colon >= 0 ? friendly.Substring(colon + 1) : friendly);
        }

        private Exception FriendlyRemoteError(WebException exception)
        {
            try
            {
                using (var stream = exception.Response.GetResponseStream()) using (var reader = new StreamReader(stream, Encoding.UTF8))
                {
                    var value = _json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object message; if (value != null && value.TryGetValue("message", out message)) return new InvalidOperationException(Convert.ToString(message));
                }
            }
            catch { }
            return new InvalidOperationException("无法连接 PMS：" + exception.Message, exception);
        }

        // 串行探测时每条不通的应用都要独占一个超时，累加起来会超过同步间隔，
        // 把心跳和 frpc 退出检测一起拖住，所以逐条并发、整轮只花一个超时。
        internal static List<GatewayRouteReport> Probe(IEnumerable<GatewayRoute> routes)
        {
            var pending = (routes ?? Enumerable.Empty<GatewayRoute>()).Where(route => route.Enabled).ToList();
            if (pending.Count == 0) return new List<GatewayRouteReport>();
            var reports = new GatewayRouteReport[pending.Count];
            var tasks = new Task[pending.Count];
            for (var index = 0; index < pending.Count; index++)
            {
                var slot = index;
                tasks[slot] = Task.Factory.StartNew(() => { reports[slot] = ProbeOne(pending[slot]); reports[slot].Id = pending[slot].Id; });
            }
            Task.WaitAll(tasks);
            return reports.ToList();
        }

        /** 探测只回答"这个应用此刻通不通"。任何异常都必须收敛成一条不健康报告：
            一旦向外抛出就会中断整条同步链路，让其余健康的应用一起失联。
            TCP 路由被拒时抛的是 SocketException、超时抛 TimeoutException，
            都不是 WebException，必须有兜底分支接住。 */
        private static GatewayRouteReport ProbeOne(GatewayRoute route)
        {
            try
            {
                Uri origin;
                if (Uri.TryCreate(route.LocalUrl, UriKind.Absolute, out origin) && origin.Scheme == "tcp")
                {
                    if (origin.Port < 1 || origin.Port > 65535) throw new InvalidOperationException("缺少有效端口");
                    using (var client = new TcpClient())
                    {
                        var pending = client.BeginConnect(origin.Host, origin.Port, null, null);
                        try
                        {
                            if (!pending.AsyncWaitHandle.WaitOne(ProbeTimeoutMilliseconds)) throw new TimeoutException("连接超时");
                            client.EndConnect(pending);
                        }
                        finally { pending.AsyncWaitHandle.Close(); }
                    }
                    return new GatewayRouteReport { AppId = route.AppId, Healthy = true, Message = "内网 TCP 端口可访问" };
                }
                var request = (HttpWebRequest)WebRequest.Create(route.LocalUrl); request.Method = "GET"; request.Timeout = ProbeTimeoutMilliseconds; request.ReadWriteTimeout = ProbeTimeoutMilliseconds; request.AllowAutoRedirect = true;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    var code = (int)response.StatusCode;
                    return new GatewayRouteReport { AppId = route.AppId, Healthy = code >= 200 && code < 400, Message = code >= 200 && code < 400 ? "内网站点可访问" : "内网站点返回 HTTP " + code };
                }
            }
            catch (WebException exception)
            {
                var response = exception.Response as HttpWebResponse;
                var message = response != null ? "内网站点返回 HTTP " + (int)response.StatusCode : "无法访问内网地址：" + exception.Message;
                return new GatewayRouteReport { AppId = route.AppId, Healthy = false, Message = message };
            }
            catch (Exception exception)
            {
                return new GatewayRouteReport { AppId = route.AppId, Healthy = false, Message = "无法访问内网地址：" + exception.Message };
            }
        }

        private static string Sign(string payload, string token)
        {
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(token))) return BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(payload))).Replace("-", "").ToLowerInvariant();
        }

        private static bool FixedEquals(string left, string right)
        {
            if (left == null || right == null || left.Length != right.Length) return false;
            var difference = 0; for (var i = 0; i < left.Length; i++) difference |= left[i] ^ right[i]; return difference == 0;
        }
    }

    internal sealed class GatewayRemovedException : Exception { public GatewayRemovedException(string message) : base(message) { } }

    internal sealed class TimedWebClient : WebClient
    {
        protected override WebRequest GetWebRequest(Uri address)
        {
            var request = base.GetWebRequest(address); request.Timeout = 15000;
            var http = request as HttpWebRequest; if (http != null) http.ReadWriteTimeout = 15000;
            return request;
        }
    }
}
