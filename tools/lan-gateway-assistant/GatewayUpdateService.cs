using System;
using System.Diagnostics;
using System.IO;
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
        public static GatewayUpdateResult CheckAndDownload(string currentVersion, string rootPath)
        {
            var overrideUrl = Environment.GetEnvironmentVariable("PMS_LAN_GATEWAY_UPDATE_MANIFEST_URL"); var url = String.IsNullOrWhiteSpace(overrideUrl) ? DefaultManifestUrl : overrideUrl;
            GatewayUpdateManifest manifest; using (var client = NewClient()) { manifest = new JavaScriptSerializer().Deserialize<GatewayUpdateManifest>(client.DownloadString(url)); }
            Version current, available; if (!Version.TryParse(currentVersion, out current) || !Version.TryParse(manifest.Version, out available)) throw new InvalidOperationException("更新清单中的版本号无效");
            if (available <= current) return new GatewayUpdateResult { HasUpdate = false, Manifest = manifest };
            Uri package; if (!Uri.TryCreate(manifest.Url, UriKind.Absolute, out package) || package.Scheme != Uri.UriSchemeHttps) throw new InvalidOperationException("更新下载地址不是 HTTPS");
            if (String.IsNullOrWhiteSpace(manifest.Sha256) || manifest.Sha256.Length != 64) throw new InvalidOperationException("更新清单缺少 SHA-256 校验值");
            var folder = Path.Combine(rootPath, "updates"); Directory.CreateDirectory(folder); var destination = Path.Combine(folder, "Pms.LanGatewayAssistant-" + available.ToString(3) + ".exe");
            using (var client = NewClient()) client.DownloadFile(package, destination);
            if (!String.Equals(Hash(destination), manifest.Sha256, StringComparison.OrdinalIgnoreCase)) { File.Delete(destination); throw new InvalidOperationException("更新包校验失败，已阻止安装"); }
            return new GatewayUpdateResult { HasUpdate = true, Manifest = manifest, DownloadedFile = destination };
        }
        public static void StartApply(string downloadedFile, string targetExecutable, int previousProcessId)
        {
            var runner = downloadedFile + ".runner-" + Guid.NewGuid().ToString("N") + ".exe"; File.Copy(downloadedFile, runner, true);
            Process.Start(new ProcessStartInfo { FileName = runner, Arguments = "--apply-update \"" + targetExecutable + "\" " + previousProcessId + " \"" + downloadedFile + "\"", UseShellExecute = true, Verb = "runas" });
        }
        public static void Apply(string targetExecutable, int previousProcessId, string payload)
        {
            try { Process.GetProcessById(previousProcessId).WaitForExit(20000); } catch { }
            var target = Path.GetFullPath(targetExecutable); var source = Path.GetFullPath(payload); var backup = target + ".previous"; var wasRunning = GatewayServiceManager.IsRunning();
            try
            {
                if (wasRunning) GatewayServiceManager.Stop(); File.Copy(target, backup, true); CopyWithRetry(source, target); if (GatewayServiceManager.Exists()) GatewayServiceManager.Start(); Process.Start(target);
            }
            catch (Exception exception)
            {
                try { if (File.Exists(backup)) File.Copy(backup, target, true); if (wasRunning && GatewayServiceManager.Exists()) GatewayServiceManager.Start(); } catch { }
                throw new InvalidOperationException("更新未完成，已恢复原版本。原因：" + exception.Message, exception);
            }
        }
        private static WebClient NewClient() { var client = new WebClient(); client.Headers[HttpRequestHeader.UserAgent] = "PMS-Lan-Gateway-Assistant"; return client; }
        private static string Hash(string path) { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        private static void CopyWithRetry(string source, string target) { Exception last = null; for (var i = 0; i < 20; i++) { try { File.Copy(source, target, true); return; } catch (Exception ex) { last = ex; Thread.Sleep(500); } } throw last ?? new IOException("无法替换程序文件"); }
    }
}
