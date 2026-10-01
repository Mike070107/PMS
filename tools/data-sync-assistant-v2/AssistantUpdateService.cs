using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Pms.DataSyncAssistant
{
    internal sealed class AssistantUpdateManifest
    {
        public string Version { get; set; }
        public string DownloadUrl { get; set; }
        // 新版发布脚本使用 url；保留 DownloadUrl 兼容旧清单。
        public string Url { get; set; }
        public string Sha256 { get; set; }
        public string ReleaseNotes { get; set; }
        public string Notes { get; set; }
    }

    internal sealed class AssistantUpdateResult
    {
        public bool HasUpdate { get; set; }
        public string CurrentVersion { get; set; }
        public AssistantUpdateManifest Manifest { get; set; }
        public string DownloadedFile { get; set; }
    }

    internal static class AssistantUpdateService
    {
        // The URL is intentionally overridable for a staging server and for an offline
        // local manifest. Production builds should publish the same manifest over HTTPS.
        public const string DefaultManifestUrl = "https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json";
        private const int TimeoutMilliseconds = 15000;
        private const long MaxPackageBytes = 100 * 1024 * 1024;

        public static AssistantUpdateResult CheckAndDownload(string currentVersion, string rootPath)
        {
            var manifest = LoadManifest(rootPath);
            var current = ParseVersion(currentVersion);
            var available = ParseVersion(manifest.Version);
            if (available <= current)
            {
                return new AssistantUpdateResult { CurrentVersion = currentVersion, Manifest = manifest, HasUpdate = false };
            }
            var downloadUrl = manifest.DownloadUrl;
            if (String.IsNullOrWhiteSpace(downloadUrl)) downloadUrl = manifest.Url;
            if (String.IsNullOrWhiteSpace(downloadUrl)) throw new InvalidOperationException("更新清单缺少下载地址");
            Uri packageUri;
            if (!Uri.TryCreate(downloadUrl, UriKind.Absolute, out packageUri) || packageUri.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("更新下载地址不是 HTTPS，已停止更新以保护助手和配置");
            if (!IsSha256(manifest.Sha256)) throw new InvalidOperationException("更新清单缺少有效的 SHA-256 校验值");

            var updateDirectory = Path.Combine(rootPath, "updates");
            Directory.CreateDirectory(updateDirectory);
            var fileName = "Pms.DataSyncAssistant.V2-" + available.ToString(3) + ".exe";
            var destination = Path.Combine(updateDirectory, fileName);
            Download(packageUri, destination);
            var actualHash = ComputeSha256(destination);
            if (!String.Equals(actualHash, manifest.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                TryDelete(destination);
                throw new InvalidOperationException("更新包校验失败，文件可能已损坏或被篡改");
            }
            return new AssistantUpdateResult { CurrentVersion = currentVersion, Manifest = manifest, HasUpdate = true, DownloadedFile = destination };
        }

        public static void StartApply(string downloadedFile, string targetExecutable, int previousProcessId)
        {
            var source = Path.GetFullPath(downloadedFile);
            var target = Path.GetFullPath(targetExecutable);
            if (String.Equals(source, target, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("更新包不能与当前程序是同一个文件");
            if (!File.Exists(source)) throw new FileNotFoundException("更新包不存在", source);
            Process.Start(new ProcessStartInfo
            {
                FileName = source,
                Arguments = "--apply-update \"" + target + "\" " + previousProcessId,
                UseShellExecute = true,
                Verb = "runas"
            });
        }

        public static void Apply(string targetExecutable, int previousProcessId)
        {
            var source = Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName);
            var target = Path.GetFullPath(targetExecutable);
            if (String.Equals(source, target, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("更新源和目标不能相同");
            WaitForProcess(previousProcessId);
            var backup = target + ".previous";
            var serviceWasRunning = UnifiedServiceManager.IsRunning();
            try
            {
                if (serviceWasRunning) UnifiedServiceManager.Stop();
                CopyFileWithRetry(target, backup, true);
                CopyFileWithRetry(source, target, true);
                if (serviceWasRunning) UnifiedServiceManager.StartExisting();
                Process.Start(new ProcessStartInfo { FileName = target, Arguments = "--updated", UseShellExecute = true });
            }
            catch (Exception exception)
            {
                try
                {
                    if (File.Exists(backup)) File.Copy(backup, target, true);
                    if (serviceWasRunning) UnifiedServiceManager.StartExisting();
                }
                catch { }
                throw new InvalidOperationException("助手更新失败，已尝试恢复上一版程序：" + exception.Message, exception);
            }
        }

        private static AssistantUpdateManifest LoadManifest(string rootPath)
        {
            var localPath = Path.Combine(rootPath, "updates", "latest.json");
            if (File.Exists(localPath))
            {
                using (var reader = new StreamReader(localPath, Encoding.UTF8))
                    return ParseManifest(reader.ReadToEnd(), "本地更新清单");
            }
            var url = Environment.GetEnvironmentVariable("PMS_ASSISTANT_UPDATE_MANIFEST_URL");
            if (String.IsNullOrWhiteSpace(url)) url = DefaultManifestUrl;
            Uri manifestUri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out manifestUri) || manifestUri.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("更新清单地址不是 HTTPS：" + url);
            var request = (HttpWebRequest)WebRequest.Create(manifestUri);
            request.Method = "GET";
            request.Timeout = TimeoutMilliseconds;
            request.ReadWriteTimeout = TimeoutMilliseconds;
            request.UserAgent = "PMS-DataSyncAssistant/" + AssemblyVersion();
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var stream = response.GetResponseStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
                return ParseManifest(reader.ReadToEnd(), url);
        }

        private static AssistantUpdateManifest ParseManifest(string json, string source)
        {
            try
            {
                var value = new JavaScriptSerializer().Deserialize<AssistantUpdateManifest>(json);
                if (value == null || String.IsNullOrWhiteSpace(value.Version)) throw new InvalidOperationException("版本号为空");
                if (String.IsNullOrWhiteSpace(value.DownloadUrl)) value.DownloadUrl = value.Url;
                if (String.IsNullOrWhiteSpace(value.ReleaseNotes)) value.ReleaseNotes = value.Notes;
                return value;
            }
            catch (Exception exception) { throw new InvalidOperationException("无法读取" + source + "：" + exception.Message, exception); }
        }

        private static void Download(Uri uri, string destination)
        {
            var request = (HttpWebRequest)WebRequest.Create(uri);
            request.Method = "GET";
            request.Timeout = TimeoutMilliseconds;
            request.ReadWriteTimeout = TimeoutMilliseconds;
            request.UserAgent = "PMS-DataSyncAssistant/" + AssemblyVersion();
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                if (response.ContentLength > MaxPackageBytes) throw new InvalidOperationException("更新包超过 100 MB，已停止下载");
                using (var input = response.GetResponseStream())
                using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    var buffer = new byte[64 * 1024];
                    long total = 0;
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        total += read;
                        if (total > MaxPackageBytes) throw new InvalidOperationException("更新包超过 100 MB，已停止下载");
                        output.Write(buffer, 0, read);
                    }
                }
            }
        }

        private static string ComputeSha256(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        private static bool IsSha256(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length != 64) return false;
            return value.All(char.IsLetterOrDigit);
        }

        private static Version ParseVersion(string value)
        {
            Version parsed;
            if (!Version.TryParse(value, out parsed)) throw new InvalidOperationException("版本号格式无效：" + value);
            return parsed;
        }

        private static string AssemblyVersion()
        {
            return typeof(AssistantUpdateService).Assembly.GetName().Version.ToString(3);
        }

        private static void WaitForProcess(int processId)
        {
            if (processId <= 0) return;
            try
            {
                var process = Process.GetProcessById(processId);
                if (!process.WaitForExit(10000)) throw new InvalidOperationException("旧助手窗口没有在 10 秒内退出");
            }
            catch (ArgumentException) { }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }

        private static void CopyFileWithRetry(string source, string destination, bool overwrite)
        {
            Exception last = null;
            for (var attempt = 0; attempt < 40; attempt++)
            {
                try
                {
                    File.Copy(source, destination, overwrite);
                    return;
                }
                catch (IOException exception)
                {
                    last = exception;
                    Thread.Sleep(500);
                }
                catch (UnauthorizedAccessException exception)
                {
                    last = exception;
                    Thread.Sleep(500);
                }
            }
            throw new IOException("旧版助手文件在停止后台服务后仍被占用，无法完成替换。请关闭所有助手窗口后重试。", last);
        }
    }
}
