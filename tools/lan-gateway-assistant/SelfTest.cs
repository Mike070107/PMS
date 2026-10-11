using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Drawing;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Pms.LanGatewayAssistant
{
    internal static class SelfTest
    {
        public static void Run()
        {
            var root = Path.Combine(Path.GetTempPath(), "pms-lan-gateway-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try
            {
                var route = new GatewayRoute { Id = "finance", Name = "Finance", PublicHostname = "finance.prsznh.cn", LocalUrl = "http://192.168.1.20:8050/tplus", RemotePort = 18050, Enabled = true };
                var config = new GatewayConfiguration { DeviceId = "lan-self-test", ComputerName = "test", ServerAddress = "gateway.prsznh.cn", ServerPort = 443, Routes = new System.Collections.Generic.List<GatewayRoute> { route } };
                var store = new GatewayConfigurationStore(root, false); store.Save(config); store.SaveToken("self-test-token"); store.SaveDeviceToken("self-test-device-token"); store.WriteRuntimeToken();
                // 探测结论过去只活在后台服务进程里，回报完心跳就丢掉，助手只能显示配置里的
                // Enabled 标志位：应用明明连不上，界面仍写「本机已启用」，和 PMS 上的「需处理」
                // 对不上。下面这些用例锁住落盘的结论，以及「没有样本时绝不充 100%」。
                var now = DateTimeOffset.Now;
                var disabledRoute = new GatewayRoute { AppId = 2, Id = "apartment", Name = "公寓物业管理系统", PublicHostname = "wyglxt.prsznh.cn", LocalUrl = "http://192.168.110.9:8080", RemotePort = 18060, Enabled = false };
                var watched = new[] { route, disabledRoute };
                var stability = GatewayStabilityLog.Merge(null, watched, new[] { new GatewayRouteReport { AppId = 0, Id = "finance", Healthy = true, Message = "内网站点可访问" } }, now);
                Require(stability.Routes.Count == 2, "stability covers every configured app");
                var measured = GatewayStabilityLog.Find(stability, route);
                Require(measured != null && measured.Healthy, "a probed app records the probe verdict");
                var unmeasured = GatewayStabilityLog.Find(stability, disabledRoute);
                Require(unmeasured != null && !unmeasured.Healthy && String.IsNullOrEmpty(unmeasured.CheckedAt), "a disabled app is never credited with a healthy check");
                Require(GatewayStabilityLog.Availability(unmeasured, now, GatewayStabilityLog.AvailabilityWindow) == null, "an app with no samples has no availability instead of 100%");
                Require(GatewayStabilityLog.Availability(measured, now, GatewayStabilityLog.AvailabilityWindow) == 1d, "a single healthy sample reads as fully available");
                for (var round = 1; round <= 3; round++)
                    stability = GatewayStabilityLog.Merge(stability, watched, new[] { new GatewayRouteReport { AppId = 0, Id = "finance", Healthy = round < 3, Message = round < 3 ? "内网站点可访问" : "无法访问内网地址：无法连接到远程服务器" } }, now.AddSeconds(round));
                measured = GatewayStabilityLog.Find(stability, route);
                Require(!measured.Healthy && measured.ConsecutiveFailures == 1, "the newest probe is the current verdict");
                Require(measured.LastFailureMessage.Contains("无法连接到远程服务器"), "the failure reason is kept for the operator");
                Require(GatewayStabilityLog.Availability(measured, now, GatewayStabilityLog.AvailabilityWindow) == 0.75d, "availability counts failures against checks");
                Require(GatewayStabilityLog.OverallAvailability(stability, now, GatewayStabilityLog.AvailabilityWindow) == 0.75d, "the whole-machine number ignores disabled apps");
                Require(GatewayStabilityLog.Availability(measured, now.AddHours(2), GatewayStabilityLog.AvailabilityWindow) == null, "samples older than the window stop counting");
                var restarted = GatewayStabilityLog.RecordRestart(GatewayStabilityLog.RecordRestart(stability, now), now.AddMinutes(1));
                Require(restarted.TunnelRestarts == 2, "tunnel restarts accumulate");
                Require(restarted.Routes.Count == 2, "recording a restart keeps the per-app history");
                store.SaveStability(restarted);
                var reloaded = store.LoadStability();
                Require(reloaded != null && reloaded.TunnelRestarts == 2, "stability survives the disk round trip the UI process depends on");
                var reloadedRoute = GatewayStabilityLog.Find(reloaded, route);
                Require(reloadedRoute != null && reloadedRoute.Minutes != null && reloadedRoute.Minutes.Count > 0, "minute buckets survive the disk round trip");
                Require(GatewayStabilityLog.Availability(reloadedRoute, now, GatewayStabilityLog.AvailabilityWindow) == 0.75d, "availability reads the same after reload");
                var capped = (GatewayStability)null;
                for (var minute = 0; minute < GatewayStabilityLog.MaximumMinutes + 20; minute++)
                    capped = GatewayStabilityLog.Merge(capped, new[] { route }, new[] { new GatewayRouteReport { AppId = 0, Id = "finance", Healthy = true, Message = "ok" } }, now.AddMinutes(minute));
                Require(GatewayStabilityLog.Find(capped, route).Minutes.Count == GatewayStabilityLog.MaximumMinutes, "history is capped so the file cannot grow without bound");
                var failingCard = new RouteViewModel(route, reloadedRoute);
                Require(failingCard.Status == "连不上", "a card shows the probe verdict, not the enabled flag");
                Require(failingCard.Detail.Contains("无法连接到远程服务器"), "a failing card names the reason on the card");
                Require(failingCard.AvailabilitySummary.Contains("75.0%"), "a card shows its own recent availability");
                Require(new RouteViewModel(route, null).Status == "等待检测", "an unmeasured card says so instead of claiming to work");
                Require(new RouteViewModel(disabledRoute, unmeasured).Status == "已停用", "a disabled card is marked disabled");
                var window = new MainWindow(store);
                try
                {
                    window.WindowStartupLocation = WindowStartupLocation.Manual; window.Left = -10000; window.Top = -10000;
                    window.Show(); window.UpdateLayout();
                    Require(window.UpdateButton != null && Convert.ToString(window.UpdateButton.Content) == "检查更新", "manual update button");
                    Require(window.ClientNameBox.Text == window.SuggestedClientName, "client name prefilled on startup");
                    window.ClientNameBox.Text = "财务室客户端";
                    Require(window.ClientNameBox.Text == "财务室客户端", "client name remains editable");
                    Require(window.Routes.Count == 1 && window.Routes[0].Status == "连不上", "the window picks up the health the service wrote");
                    Require(window.AppHealthDisplay == "0/1", "the overview counts connected apps, not configured ones");
                    Require(window.StabilityDisplay == "75.0%", "the overview shows the whole-machine availability");
                    Require(window.StabilitySummary.Contains("自动重启 2 次"), "the overview reports tunnel restarts");
                    Require(FindButton(window, "删除") != null, "every app card offers a delete action");
                    Require(FindButton(window, "测试连接") != null, "every app card offers a connectivity test");
                    Require(FindButton(window, "打开网站") != null, "every app card can open its public site");
                }
                finally { window.Close(); }
                var text = FrpConfiguration.Build(config, store);
                Require(text.Contains("serverPort = 443"), "server port"); Require(text.Contains("transport.protocol = \"wss\""), "wss"); Require(text.Contains("user = \"lan-self-test\""), "device identity"); Require(text.Contains("metadatas.deviceToken = \"self-test-device-token\""), "device admission token"); Require(text.Contains("localIP = \"192.168.1.20\""), "local ip"); Require(text.Contains("localPort = 8050"), "local port"); Require(text.Contains("remotePort = 18050"), "remote port");
                config.Routes.Add(new GatewayRoute { Id = "temporary-ssh", Name = "Temporary SSH", PublicHostname = "maintenance.prsznh.cn", LocalUrl = "tcp://192.168.110.249:22", RemotePort = 18997, Enabled = true });
                var tcpText = FrpConfiguration.Build(config, store);
                Require(tcpText.Contains("name = \"temporary-ssh\""), "tcp route name"); Require(tcpText.Contains("localIP = \"192.168.110.249\""), "tcp route ip"); Require(tcpText.Contains("localPort = 22"), "tcp route port"); Require(tcpText.Contains("remotePort = 18997"), "tcp remote port");
                var sample = new byte[] { 1, 2, 3, 4 }; var protectedValue = ProtectedData.Protect(sample, null, DataProtectionScope.LocalMachine); var roundTrip = ProtectedData.Unprotect(protectedValue, null, DataProtectionScope.LocalMachine); Require(roundTrip.Length == sample.Length, "dpapi");
                Require(GatewayUpdateService.IsTrustedDownloadUrl(new Uri("https://prsznh.cn/downloads/pms-lan-gateway-assistant/1.2.1/Pms.LanGatewayAssistant.exe")), "trusted update URL");
                Require(!GatewayUpdateService.IsTrustedDownloadUrl(new Uri("http://prsznh.cn/downloads/pms-lan-gateway-assistant/x.exe")), "reject HTTP update URL");
                Require(!GatewayUpdateService.IsTrustedDownloadUrl(new Uri("https://prsznh.cn.evil.example/downloads/pms-lan-gateway-assistant/x.exe")), "reject lookalike update host");
                Require(!GatewayUpdateService.IsTrustedDownloadUrl(new Uri("https://prsznh.cn/downloads/other/x.exe")), "reject unrelated update path");
                Require(GatewayUpdateService.IsSha256(new string('a', 64)), "valid sha256");
                Require(!GatewayUpdateService.IsSha256(new string('z', 64)), "reject non-hex sha256");
                store.WriteActivity("silent update test");
                Require(File.Exists(store.ActivityLogPath), "silent update activity log");
                var heartbeat = GatewayControlPlaneClient.BuildHeartbeatJson("1.2.2", true, 3, new[] { new GatewayRouteReport { AppId = 9, Healthy = true, Message = "ok" } }, null);
                Require(heartbeat.Contains("\"appId\":9"), "heartbeat lower camel app id");
                Require(heartbeat.Contains("\"healthy\":true"), "heartbeat lower camel health");
                Require(!heartbeat.Contains("\"AppId\""), "heartbeat rejects PascalCase route fields");
                // 一条内网服务停机曾经会让整份配置同步中断，把其余健康的应用一起拖下线。
                // 探测必须把每种失败都收敛成报告：端口被拒是 SocketException、无效端口是
                // InvalidOperationException，都不是 WebException，缺了兜底就会向外冒泡。
                var offlineHttp = new GatewayRoute { AppId = 101, Name = "Offline HTTP", PublicHostname = "a.prsznh.cn", LocalUrl = "http://127.0.0.1:1/", RemotePort = 18101, Enabled = true };
                var offlineTcp = new GatewayRoute { AppId = 102, Name = "Offline TCP", PublicHostname = "b.prsznh.cn", LocalUrl = "tcp://127.0.0.1:1", RemotePort = 18102, Enabled = true };
                var brokenPort = new GatewayRoute { AppId = 103, Name = "Broken Port", PublicHostname = "c.prsznh.cn", LocalUrl = "tcp://127.0.0.1:0", RemotePort = 18103, Enabled = true };
                var stopped = new GatewayRoute { AppId = 104, Name = "Stopped", PublicHostname = "d.prsznh.cn", LocalUrl = "http://127.0.0.1:1/", RemotePort = 18104, Enabled = false };
                var probed = GatewayControlPlaneClient.Probe(new[] { offlineHttp, offlineTcp, brokenPort, stopped });
                Require(probed.Count == 3, "probe skips disabled routes");
                Require(probed.All(item => item != null && !item.Healthy), "unreachable routes report unhealthy instead of throwing");
                Require(probed.All(item => !String.IsNullOrWhiteSpace(item.Message)), "every unhealthy report carries a reason");
                Require(probed.Any(item => item.AppId == 102) && probed.Any(item => item.AppId == 103), "socket and invalid-port failures are captured, not propagated");
                Require(GatewayControlPlaneClient.Probe(new GatewayRoute[0]).Count == 0, "probe tolerates an empty route set");
                // 「内网服务修好了吗」恰恰是停用期间最需要手动点的一次测试。Probe 会跳过停用
                // 的应用，所以手动测试不能借道 Probe——那会抛 Sequence contains no elements。
                var manual = new GatewayControlPlaneClient(store).TestRoute(stopped);
                Require(manual != null && !manual.Healthy && manual.AppId == 104, "a disabled app can still be tested by hand");
                var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
                listener.Start();
                try
                {
                    var livePort = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
                    var live = new GatewayRoute { AppId = 105, Name = "Live", PublicHostname = "e.prsznh.cn", LocalUrl = "tcp://127.0.0.1:" + livePort, RemotePort = 18105, Enabled = true };
                    var mixed = GatewayControlPlaneClient.Probe(new[] { offlineHttp, live, offlineTcp });
                    Require(mixed.Single(item => item.AppId == 105).Healthy, "a reachable app stays healthy beside a stopped one");
                    Require(!mixed.Single(item => item.AppId == 101).Healthy, "the stopped app is still reported unhealthy");
                    Require(mixed.Count == 3, "every enabled app gets its own verdict");
                }
                finally { listener.Stop(); }
                // 代理核心瞬时崩溃不该换来一整分钟断线，但反复崩溃要逐步退让并封顶。
                Require(GatewayRuntime.NextDelay(TimeSpan.FromSeconds(5)) == TimeSpan.FromSeconds(10), "restart backoff doubles");
                var backoff = TimeSpan.FromSeconds(5);
                for (var attempt = 0; attempt < 10; attempt++) backoff = GatewayRuntime.NextDelay(backoff);
                Require(backoff == TimeSpan.FromMinutes(1), "restart backoff stops at one minute");
                var executableIcon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName);
                Require(executableIcon != null, "embedded tray icon");
                executableIcon.Dispose();
            }
            finally { try { Directory.Delete(root, true); } catch { } }
        }
        public static void RenderMainWindow(string outputPath)
        {
            var root = Path.Combine(Path.GetTempPath(), "pms-lan-gateway-render-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try
            {
                var store = new GatewayConfigurationStore(root, false);
                var routes = new System.Collections.Generic.List<GatewayRoute>
                {
                    new GatewayRoute { AppId = 1, Id = "finance", Name = "用友财务系统", PublicHostname = "caiwu.prsznh.cn", LocalUrl = "http://192.168.110.251:8050", RemotePort = 18050, Enabled = true },
                    new GatewayRoute { AppId = 3, Id = "warehouse", Name = "仓库管理", PublicHostname = "warehouse.prsznh.cn", LocalUrl = "http://192.168.110.88:8080", RemotePort = 18051, Enabled = true },
                    new GatewayRoute { AppId = 2, Id = "apartment", Name = "公寓物业管理系统", PublicHostname = "wyglxt.prsznh.cn", LocalUrl = "http://192.168.110.9:8080", RemotePort = 18060, Enabled = false }
                };
                store.Save(new GatewayConfiguration
                {
                    DeviceId = "lan-finance-preview",
                    ComputerName = "FINANCE-PC",
                    ServerAddress = "gateway.prsznh.cn",
                    ServerPort = 443,
                    AppliedRevision = 17,
                    Routes = routes
                });
                store.SaveDeviceToken("preview-device-token"); store.SaveToken("preview-frp-token");
                // 预览要同时摊开三种状态：连得上、连不上、已停用。只画「全绿」的图没法
                // 判断出事时界面说得清不清楚。
                var start = DateTimeOffset.Now.AddMinutes(-40);
                var preview = (GatewayStability)null;
                for (var minute = 0; minute <= 40; minute++)
                {
                    var warehouseHealthy = minute < 36;
                    preview = GatewayStabilityLog.Merge(preview, routes, new[]
                    {
                        new GatewayRouteReport { AppId = 1, Id = "finance", Healthy = true, Message = "内网站点可访问" },
                        new GatewayRouteReport { AppId = 3, Id = "warehouse", Healthy = warehouseHealthy, Message = warehouseHealthy ? "内网站点可访问" : "无法访问内网地址：无法连接到远程服务器" }
                    }, start.AddMinutes(minute));
                }
                preview = GatewayStabilityLog.RecordRestart(preview, start.AddMinutes(36));
                store.SaveStability(preview);
                var window = new MainWindow(store); window.Width = 1040; window.Height = 860; window.WindowStartupLocation = WindowStartupLocation.Manual; window.Left = -10000; window.Top = -10000;
                window.Show(); window.UpdateLayout();
                var bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(window);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))); using (var stream = File.Create(outputPath)) encoder.Save(stream);
                window.Close();
            }
            finally { try { Directory.Delete(root, true); } catch { } }
        }
        private static void Require(bool value, string name) { if (!value) throw new InvalidOperationException("自检失败：" + name); }
        /** 按钮在卡片模板里，只有真正布局过才存在；模板写错时这里就该红。 */
        private static System.Windows.Controls.Button FindButton(DependencyObject root, string content)
        {
            var count = VisualTreeHelper.GetChildrenCount(root);
            for (var index = 0; index < count; index++)
            {
                var child = VisualTreeHelper.GetChild(root, index);
                var button = child as System.Windows.Controls.Button;
                if (button != null && String.Equals(Convert.ToString(button.Content), content, StringComparison.Ordinal)) return button;
                var found = FindButton(child, content);
                if (found != null) return found;
            }
            return null;
        }
    }
}
