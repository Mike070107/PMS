using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewayUpdateManifest { public string Version { get; set; } public string Url { get; set; } public string Sha256 { get; set; } public string Notes { get; set; } }
    internal sealed class GatewayUpdateResult { public bool HasUpdate { get; set; } public GatewayUpdateManifest Manifest { get; set; } public string DownloadedFile { get; set; } }
    internal static class GatewayUpdateService
    {
        public const string DefaultManifestUrl = "https://prsznh.cn/downloads/pms-lan-gateway-assistant/latest.json";
        private const int TimeoutMilliseconds = 15000;
        private const long MaxPackageBytes = 20 * 1024 * 1024;

        public static GatewayUpdateResult CheckAndDownload(string currentVersion, string rootPath)
        {
            var overrideUrl = Environment.GetEnvironmentVariable("PMS_LAN_GATEWAY_UPDATE_MANIFEST_URL");
            var manifestUrl = String.IsNullOrWhiteSpace(overrideUrl) ? DefaultManifestUrl : overrideUrl;
            var manifest = LoadManifest(manifestUrl);
            Version current, available;
            if (!Version.TryParse(currentVersion, out current) || !Version.TryParse(manifest.Version, out available))
                throw new InvalidOperationException("更新清单中的版本号无效");
            if (available <= current) return new GatewayUpdateResult { HasUpdate = false, Manifest = manifest };

            Uri package;
            if (!Uri.TryCreate(manifest.Url, UriKind.Absolute, out package) || package.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("更新下载地址不是 HTTPS");
            if (!IsTrustedDownloadUrl(package)) throw new InvalidOperationException("更新下载地址不属于 PMS 可信发布路径");
            if (!IsSha256(manifest.Sha256)) throw new InvalidOperationException("更新清单缺少有效的 SHA-256 校验值");

            var folder = Path.Combine(rootPath, "updates");
            Directory.CreateDirectory(folder);
            var destination = Path.Combine(folder, "Pms.LanGatewayAssistant-" + available.ToString(3) + ".exe");
            Download(package, destination);
            if (!String.Equals(Hash(destination), manifest.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                TryDelete(destination);
                throw new InvalidOperationException("更新包校验失败，已阻止安装");
            }
            var fileVersion = FileVersionInfo.GetVersionInfo(destination).FileVersion;
            Version payloadVersion;
            if (!Version.TryParse(fileVersion, out payloadVersion) || payloadVersion.Major != available.Major || payloadVersion.Minor != available.Minor || payloadVersion.Build != available.Build)
            {
                TryDelete(destination);
                throw new InvalidOperationException("更新包文件版本与发布清单不一致");
            }
            return new GatewayUpdateResult { HasUpdate = true, Manifest = manifest, DownloadedFile = destination };
        }

        public static void StartApply(string downloadedFile, string targetExecutable, int previousProcessId)
        {
            var source = Path.GetFullPath(downloadedFile);
            var target = Path.GetFullPath(targetExecutable);
            if (!File.Exists(source)) throw new FileNotFoundException("更新包不存在", source);
            if (String.Equals(source, target, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("更新包不能与当前程序使用同一文件");
            foreach (var stale in Directory.GetFiles(Path.GetDirectoryName(source), "*.runner-*.exe")) TryDelete(stale);
            var runner = source + ".runner-" + Guid.NewGuid().ToString("N") + ".exe";
            File.Copy(source, runner, true);
            Process.Start(new ProcessStartInfo { FileName = runner, Arguments = "--apply-update \"" + target + "\" " + previousProcessId + " \"" + source + "\"", UseShellExecute = true, Verb = "runas" });
        }

        public static void Apply(string targetExecutable, int previousProcessId, string payload)
        {
            WaitForProcess(previousProcessId);
            var target = Path.GetFullPath(targetExecutable);
            var source = Path.GetFullPath(payload);
            var backup = target + ".previous";
            var wasRunning = GatewayServiceManager.IsRunning();
            try
            {
                if (wasRunning) GatewayServiceManager.Stop();
                File.Copy(target, backup, true);
                CopyWithRetry(source, target);
                if (GatewayServiceManager.Exists()) GatewayServiceManager.Start();
                Process.Start(target);
            }
            catch (Exception exception)
            {
                try { if (File.Exists(backup)) File.Copy(backup, target, true); if (wasRunning && GatewayServiceManager.Exists()) GatewayServiceManager.Start(); } catch { }
                throw new InvalidOperationException("更新未完成，已恢复原版本。原因：" + exception.Message, exception);
            }
        }

        internal static bool IsTrustedDownloadUrl(Uri uri)
        {
            return uri != null && uri.Scheme == Uri.UriSchemeHttps &&
                   String.Equals(uri.Host, "prsznh.cn", StringComparison.OrdinalIgnoreCase) &&
                   uri.AbsolutePath.StartsWith("/downloads/pms-lan-gateway-assistant/", StringComparison.Ordinal);
        }

        internal static bool IsSha256(string value)
        {
            return !String.IsNullOrWhiteSpace(value) && value.Length == 64 && value.All(delegate(char valueChar) { return Uri.IsHexDigit(valueChar); });
        }

        private static GatewayUpdateManifest LoadManifest(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("更新清单地址不是 HTTPS");
            var request = NewRequest(uri);
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, System.Text.Encoding.UTF8, true))
            {
                try
                {
                    var manifest = new JavaScriptSerializer().Deserialize<GatewayUpdateManifest>(reader.ReadToEnd());
                    if (manifest == null || String.IsNullOrWhiteSpace(manifest.Version)) throw new InvalidOperationException("版本号为空");
                    return manifest;
                }
                catch (Exception exception) { throw new InvalidOperationException("无法读取更新清单：" + exception.Message, exception); }
            }
        }

        private static void Download(Uri uri, string destination)
        {
            var request = NewRequest(uri);
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                if (response.ContentLength > MaxPackageBytes) throw new InvalidOperationException("更新包超过 20 MB，已停止下载");
                using (var input = response.GetResponseStream())
                using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    var buffer = new byte[64 * 1024];
                    long total = 0;
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        total += read;
                        if (total > MaxPackageBytes) throw new InvalidOperationException("更新包超过 20 MB，已停止下载");
                        output.Write(buffer, 0, read);
                    }
                }
            }
        }

        private static HttpWebRequest NewRequest(Uri uri)
        {
            var request = (HttpWebRequest)WebRequest.Create(uri);
            request.Method = "GET";
            request.Timeout = TimeoutMilliseconds;
            request.ReadWriteTimeout = TimeoutMilliseconds;
            request.UserAgent = "PMS-Lan-Gateway-Assistant";
            return request;
        }

        private static void WaitForProcess(int processId)
        {
            if (processId <= 0) return;
            try
            {
                var process = Process.GetProcessById(processId);
                if (process.WaitForExit(10000)) return;
                try { process.CloseMainWindow(); } catch { }
                if (process.WaitForExit(3000)) return;
                try { process.Kill(); } catch { }
                if (!process.WaitForExit(5000)) throw new InvalidOperationException("旧助手窗口无法退出");
            }
            catch (ArgumentException) { }
        }

        private static string Hash(string path) { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        private static void CopyWithRetry(string source, string target) { Exception last = null; for (var i = 0; i < 20; i++) { try { File.Copy(source, target, true); return; } catch (Exception ex) { last = ex; Thread.Sleep(500); } } throw last ?? new IOException("无法替换程序文件"); }
        private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }
    }
}
