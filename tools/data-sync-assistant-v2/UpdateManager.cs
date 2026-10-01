using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Pms.DataSyncAssistant
{
    internal sealed class UpdateManifest
    {
        public string Version { get; set; }
        public string Url { get; set; }
        public string Sha256 { get; set; }
        public string Notes { get; set; }
        public string PublishedAt { get; set; }
    }

    internal sealed class ProductUpdateState
    {
        public string Phase { get; set; }
        public int Percent { get; set; }
        public string Message { get; set; }
        public string CurrentVersion { get; set; }
        public string TargetVersion { get; set; }
        public string InstalledVersion { get; set; }
        public string InstalledExecutable { get; set; }
        public string Error { get; set; }
        public string UpdatedAt { get; set; }
    }

    internal static class UpdateManager
    {
        internal const string ManifestUrl = "https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json";
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        internal static string CurrentVersion
        {
            get { return Assembly.GetExecutingAssembly().GetName().Version.ToString(3); }
        }

        internal static string StatePath
        {
            get { return Path.Combine(new ConfigurationStore().RootPath, "product-update.json"); }
        }

        internal static ProductUpdateState GetState()
        {
            try
            {
                if (!File.Exists(StatePath)) return null;
                return Serializer.Deserialize<ProductUpdateState>(File.ReadAllText(StatePath, Encoding.UTF8));
            }
            catch { return null; }
        }

        internal static void CheckAndInstall(bool serviceContext)
        {
            var root = new ConfigurationStore().RootPath;
            Directory.CreateDirectory(root);
            var lockPath = Path.Combine(root, "product-update.lock");
            FileStream updateLock;
            try { updateLock = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { return; }
            try
            {
                using (updateLock)
                {
                    WriteState("checking", 5, "正在检查新版本…", null, null, null);
                    var manifest = DownloadManifest(ManifestUrl);
                    var target = ParseVersion(manifest.Version, "更新清单中的版本号无效");
                    var current = ParseVersion(CurrentVersion, "当前程序版本号无效");
                    if (target.CompareTo(current) <= 0)
                    {
                        WriteState("current", 100, "当前已是最新版本", manifest.Version, CurrentVersion,
                            Process.GetCurrentProcess().MainModule.FileName);
                        return;
                    }

                    var releaseDirectory = Path.Combine(root, "releases", target.ToString(3));
                    Directory.CreateDirectory(releaseDirectory);
                    var executable = Path.Combine(releaseDirectory, "Pms.DataSyncAssistant.V2.exe");
                    var temporary = executable + ".download";
                    DownloadPackage(manifest, temporary);
                    WriteState("verifying", 82, "正在校验下载文件…", manifest.Version, null, null);
                    VerifyPackage(temporary, manifest, target);
                    if (File.Exists(executable)) File.Delete(executable);
                    File.Move(temporary, executable);
                    WriteState("installing", 90, "新版已下载，正在安全切换后台服务…", manifest.Version, null, executable);

                    var oldExecutable = Process.GetCurrentProcess().MainModule.FileName;
                    if (serviceContext)
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = executable,
                            Arguments = "--apply-product-update " + Quote(oldExecutable),
                            UseShellExecute = false,
                            CreateNoWindow = true
                        });
                    }
                    else
                    {
                        var process = Process.Start(new ProcessStartInfo
                        {
                            FileName = executable,
                            Arguments = "--apply-product-update " + Quote(oldExecutable),
                            UseShellExecute = true,
                            Verb = "runas"
                        });
                        if (process == null) throw new InvalidOperationException("未能启动新版安装程序");
                    }
                }
            }
            catch (Exception exception)
            {
                WriteFailure(exception.Message);
                throw;
            }
        }

        internal static void ApplyDownloadedUpdate(string previousExecutable)
        {
            var currentExecutable = Process.GetCurrentProcess().MainModule.FileName;
            var version = FileVersionInfo.GetVersionInfo(currentExecutable).FileVersion;
            try
            {
                WriteState("installing", 93, "正在停止旧版后台服务…", version, null, currentExecutable);
                if (UnifiedServiceManager.Exists()) UnifiedServiceManager.SwitchServiceExecutable(currentExecutable);
                else UnifiedServiceManager.Install();
                WriteState("installed", 100, "新版已安装，后台服务已自动恢复运行", version, version, currentExecutable);
            }
            catch (Exception exception)
            {
                try
                {
                    if (!String.IsNullOrWhiteSpace(previousExecutable) && File.Exists(previousExecutable))
                        UnifiedServiceManager.SwitchServiceExecutable(previousExecutable);
                }
                catch { }
                WriteFailure("新版切换失败，已尝试恢复旧版服务：" + exception.Message);
                throw;
            }
        }

        internal static void WriteFailure(string message)
        {
            var previous = GetState();
            WriteState("failed", 0, "自动更新未完成", previous == null ? null : previous.TargetVersion,
                previous == null ? null : previous.InstalledVersion,
                previous == null ? null : previous.InstalledExecutable, message);
        }

        internal static bool IsTrustedDownloadUrl(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) &&
                   uri.Scheme == Uri.UriSchemeHttps &&
                   String.Equals(uri.Host, "prsznh.cn", StringComparison.OrdinalIgnoreCase) &&
                   uri.AbsolutePath.StartsWith("/downloads/pms-data-sync-assistant/", StringComparison.Ordinal);
        }

        internal static bool IsVersionAtLeast(string candidate, string minimum)
        {
            Version candidateVersion;
            Version minimumVersion;
            return Version.TryParse(candidate, out candidateVersion) && Version.TryParse(minimum, out minimumVersion) &&
                   candidateVersion.CompareTo(minimumVersion) >= 0;
        }

        private static UpdateManifest DownloadManifest(string url)
        {
            if (!IsTrustedDownloadUrl(url)) throw new InvalidOperationException("更新地址不受信任");
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 15000;
                request.ReadWriteTimeout = 15000;
                request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    UpdateManifest manifest;
                    try { manifest = Serializer.Deserialize<UpdateManifest>(reader.ReadToEnd()); }
                    catch { throw new InvalidOperationException("更新服务器返回的清单格式不正确"); }
                    if (manifest == null || String.IsNullOrWhiteSpace(manifest.Version) ||
                        String.IsNullOrWhiteSpace(manifest.Url) || String.IsNullOrWhiteSpace(manifest.Sha256))
                        throw new InvalidOperationException("服务器返回的更新清单不完整");
                    if (!IsTrustedDownloadUrl(manifest.Url)) throw new InvalidOperationException("新版下载地址不受信任");
                    return manifest;
                }
            }
            catch (WebException exception) { throw new InvalidOperationException("无法连接 PMS 更新服务器，请检查网络后重试", exception); }
        }

        private static void DownloadPackage(UpdateManifest manifest, string temporary)
        {
            if (File.Exists(temporary)) File.Delete(temporary);
            var request = (HttpWebRequest)WebRequest.Create(manifest.Url);
            request.Timeout = 20000;
            request.ReadWriteTimeout = 30000;
            request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            using (var response = request.GetResponse())
            using (var input = response.GetResponseStream())
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var length = response.ContentLength;
                var buffer = new byte[64 * 1024];
                long received = 0;
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                    received += read;
                    var percent = length > 0 ? 12 + (int)Math.Min(66, received * 66 / length) : 35;
                    WriteState("downloading", percent, length > 0
                        ? "正在下载新版… " + Math.Min(100, received * 100 / length) + "%"
                        : "正在下载新版…", manifest.Version, null, null);
                }
            }
        }

        private static void VerifyPackage(string path, UpdateManifest manifest, Version target)
        {
            string hash;
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
                hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(hash, manifest.Sha256.Trim(), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("新版文件校验失败，已阻止安装");
            var fileVersion = ParseVersion(FileVersionInfo.GetVersionInfo(path).FileVersion, "新版程序版本信息无效");
            if (fileVersion.ToString(3) != target.ToString(3))
                throw new InvalidOperationException("新版程序与更新清单的版本不一致");
        }

        private static Version ParseVersion(string value, string error)
        {
            Version version;
            if (!Version.TryParse(value, out version)) throw new InvalidOperationException(error);
            return version;
        }

        private static void WriteState(string phase, int percent, string message, string targetVersion,
            string installedVersion, string installedExecutable, string error = null)
        {
            var state = new ProductUpdateState
            {
                Phase = phase,
                Percent = Math.Max(0, Math.Min(100, percent)),
                Message = message,
                CurrentVersion = CurrentVersion,
                TargetVersion = targetVersion,
                InstalledVersion = installedVersion,
                InstalledExecutable = installedExecutable,
                Error = error,
                UpdatedAt = DateTimeOffset.Now.ToString("o")
            };
            var path = StatePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var temporary = path + ".new";
            File.WriteAllText(temporary, Serializer.Serialize(state), Encoding.UTF8);
            if (File.Exists(path)) File.Replace(temporary, path, path + ".previous", true);
            else File.Move(temporary, path);
        }

        private static string Quote(string value)
        {
            return "\"" + (value ?? String.Empty).Replace("\"", "\\\"") + "\"";
        }
    }
}
