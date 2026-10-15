using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Web.Script.Serialization;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessCardUpdateManifest
    {
        public string version { get; set; }
        public string downloadUrl { get; set; }
        public string sha256 { get; set; }
        public string signerThumbprint { get; set; }
        public string releaseNotes { get; set; }
    }

    internal sealed class StagedAccessCardUpdate
    {
        public string version { get; set; }
        public string executablePath { get; set; }
        public string sha256 { get; set; }
        public string signerThumbprint { get; set; }
        public string releaseNotes { get; set; }
        public string stagedAt { get; set; }
    }

    internal static class AutomaticUpdater
    {
        internal const string ManifestUrl = "https://prsznh.cn/downloads/pms-access-card-assistant/latest.json";
        private const string StateFileName = "staged-update.json";

        public static bool CheckAndStage()
        {
            using (var client = new WebClient { Encoding = Encoding.UTF8 })
            {
                client.Headers[HttpRequestHeader.UserAgent] = "PMS-Access-Card-Assistant/" + AgentApiClient.Version;
                var manifest = new JavaScriptSerializer().Deserialize<AccessCardUpdateManifest>(client.DownloadString(ManifestUrl));
                Version current;
                Version next;
                if (manifest == null || !Version.TryParse(AgentApiClient.Version, out current) ||
                    !Version.TryParse(manifest.version, out next) || next <= current) return false;
                Uri uri;
                if (!Uri.TryCreate(manifest.downloadUrl, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps ||
                    !String.Equals(uri.Host, "prsznh.cn", StringComparison.OrdinalIgnoreCase) ||
                    !uri.AbsolutePath.StartsWith("/downloads/pms-access-card-assistant/", StringComparison.Ordinal))
                    throw new InvalidOperationException("更新下载地址不可信");
                if (String.IsNullOrWhiteSpace(manifest.signerThumbprint))
                    throw new InvalidOperationException("更新清单未配置代码签名证书，已拒绝自动更新");

                var updateDirectory = UpdateDirectory();
                Directory.CreateDirectory(updateDirectory);
                var downloaded = Path.Combine(updateDirectory, "Pms.AccessCardAssistant-" + next + ".exe");
                client.DownloadFile(uri, downloaded);
                if (!String.Equals(Hash(downloaded), (manifest.sha256 ?? "").Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    TryDelete(downloaded);
                    throw new InvalidOperationException("更新文件哈希校验失败");
                }
                if (!HasTrustedSignature(downloaded, manifest.signerThumbprint))
                {
                    TryDelete(downloaded);
                    throw new InvalidOperationException("更新文件签名无效或发布者不匹配");
                }

                var staged = new StagedAccessCardUpdate
                {
                    version = next.ToString(),
                    executablePath = downloaded,
                    sha256 = manifest.sha256.Trim(),
                    signerThumbprint = manifest.signerThumbprint.Trim(),
                    releaseNotes = manifest.releaseNotes ?? "",
                    stagedAt = DateTime.UtcNow.ToString("o")
                };
                File.WriteAllText(StatePath(), new JavaScriptSerializer().Serialize(staged), Encoding.UTF8);
                return true;
            }
        }

        public static StagedAccessCardUpdate GetStagedUpdate()
        {
            try
            {
                if (!File.Exists(StatePath())) return null;
                var staged = new JavaScriptSerializer().Deserialize<StagedAccessCardUpdate>(File.ReadAllText(StatePath(), Encoding.UTF8));
                Version current;
                Version next;
                if (staged == null || !Version.TryParse(AgentApiClient.Version, out current) ||
                    !Version.TryParse(staged.version, out next) || next <= current ||
                    String.IsNullOrWhiteSpace(staged.executablePath) || !File.Exists(staged.executablePath) ||
                    !String.Equals(Hash(staged.executablePath), staged.sha256, StringComparison.OrdinalIgnoreCase) ||
                    !HasTrustedSignature(staged.executablePath, staged.signerThumbprint)) return null;
                return staged;
            }
            catch { return null; }
        }

        public static void StartInstall(StagedAccessCardUpdate staged)
        {
            if (staged == null || !File.Exists(staged.executablePath))
                throw new InvalidOperationException("暂存的更新文件不存在，请等待重新下载");
            if (!String.Equals(Hash(staged.executablePath), staged.sha256, StringComparison.OrdinalIgnoreCase) ||
                !HasTrustedSignature(staged.executablePath, staged.signerThumbprint))
                throw new InvalidOperationException("暂存更新的签名或哈希已变化，请等待重新下载");
            var target = Process.GetCurrentProcess().MainModule.FileName;
            Process.Start(new ProcessStartInfo
            {
                FileName = staged.executablePath,
                Arguments = "--apply-update \"" + target + "\" " + Process.GetCurrentProcess().Id,
                UseShellExecute = true,
                Verb = "runas"
            });
        }

        public static void ClearStagedUpdate()
        {
            TryDelete(StatePath());
        }

        private static bool HasTrustedSignature(string path, string expectedThumbprint)
        {
            try
            {
                var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
                if (!String.Equals(NormalizeThumbprint(certificate.Thumbprint), NormalizeThumbprint(expectedThumbprint), StringComparison.OrdinalIgnoreCase)) return false;
                using (var chain = new X509Chain())
                {
                    chain.ChainPolicy.RevocationMode = X509RevocationMode.Online;
                    chain.ChainPolicy.RevocationFlag = X509RevocationFlag.ExcludeRoot;
                    return chain.Build(certificate);
                }
            }
            catch { return false; }
        }

        private static string NormalizeThumbprint(string value)
        {
            return (value ?? "").Replace(" ", "").Trim();
        }

        private static string UpdateDirectory()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "updates");
        }

        private static string StatePath()
        {
            return Path.Combine(UpdateDirectory(), StateFileName);
        }

        private static string Hash(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }
}
