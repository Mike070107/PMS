using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Pms.DataSyncAssistant
{
    internal static class InstallationSelfTest
    {
        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("安装回归：" + message);
        }

        internal static void Run(string testRoot)
        {
            Assert(!UpdateManager.IsNewerVersion("2.6.0.0", "2.6.0") && UpdateManager.IsNewerVersion("2.6.1.0", "2.6.0"), "相同产品版本不能错误提示打开新版");
            Assert(!UpdateManager.IsTrustedDownloadUrl("https://prsznh.cn:8443/downloads/pms-data-sync-assistant/test.exe") &&
                !UpdateManager.IsTrustedDownloadUrl("https://user@prsznh.cn/downloads/pms-data-sync-assistant/test.exe"), "下载仅接受官方443端口且不含用户信息");
            Assert(ProductInstallation.Quote("trailing\\") == "\"trailing\\\\\"" &&
                ProductInstallation.Quote("a\"b") == "\"a\\\"b\"", "固定入口转发需保留引号与尾部反斜杠");
            var source = ProductInstallation.CurrentExecutable;
            var version = UpdateManager.CurrentVersion;
            var root = Path.Combine(testRoot, "managed-install");
            var health = Path.Combine(testRoot, "installation-test-health.json");
            var verificationStarted = DateTimeOffset.Now.AddSeconds(-1);
            Action<string, string, int, DateTimeOffset> writeHealth = delegate(string executable, string evidenceVersion, int pid, DateTimeOffset timestamp)
            {
                ProductInstallation.WriteAtomic(health, new { executable = executable, version = evidenceVersion,
                    processId = pid, checkedAt = timestamp.ToString("o") });
            };
            var currentPid = System.Diagnostics.Process.GetCurrentProcess().Id;
            writeHealth(source, version, currentPid, DateTimeOffset.Now);
            Assert(ProductInstallation.HasFreshReadyEvidence(health, source, verificationStarted), "必须接受实际进程的全新就绪证据");
            writeHealth(source, version, currentPid, DateTimeOffset.Now.AddSeconds(-3));
            Assert(!ProductInstallation.HasFreshReadyEvidence(health, source, verificationStarted), "同版本重启不能复用安装前的健康证据");
            writeHealth(source, version, currentPid, DateTimeOffset.Now.AddMinutes(1));
            Assert(!ProductInstallation.HasFreshReadyEvidence(health, source, verificationStarted), "未来时间不能冒充就绪");
            writeHealth(source + ".wrong", version, currentPid, DateTimeOffset.Now);
            Assert(!ProductInstallation.HasFreshReadyEvidence(health, source, verificationStarted), "错误路径不能冒充新版本就绪");
            writeHealth(source, "0.0.0", currentPid, DateTimeOffset.Now);
            Assert(!ProductInstallation.HasFreshReadyEvidence(health, source, verificationStarted), "错误版本不能冒充就绪");
            writeHealth(source, version, Int32.MaxValue, DateTimeOffset.Now);
            Assert(!ProductInstallation.HasFreshReadyEvidence(health, source, verificationStarted), "不存在的服务进程不能冒充就绪");
            var running = false;
            string servicePath = null;
            var verified = new List<string>();
            var services = new InstallationServices
            {
                ReadExecutable = delegate { return servicePath; },
                IsRunning = delegate { return running; },
                Start = delegate(string exe) { servicePath = exe; running = true; },
                Stop = delegate { running = false; },
                Remove = delegate { servicePath = null; running = false; },
                Verify = delegate(string exe) { Assert(servicePath == exe && running, "验证必须针对实际启动的服务"); verified.Add(exe); }
            };
            ProductInstallation.InstallCore(root, source, services);
            var installed = ProductInstallation.ReadInstalled(root);
            var target = ProductInstallation.VersionExecutable(root, version);
            Assert(installed.ActiveVersion == version && servicePath == target && verified.Contains(target), "首次安装必须先验证才保存入口");
            var launcher = Path.Combine(root, ProductInstallation.LauncherName);
            var launcherHash = ProductInstallation.Hash(launcher);
            ProductInstallation.InstallCore(root, source, services);
            Assert(ProductInstallation.Hash(launcher) == launcherHash, "重装不得覆盖固定启动器");
            Assert(!File.Exists(Path.Combine(root, "installation-pending.json")), "成功后必须清除事务记录");
            using (var held = new FileStream(Path.Combine(root, "installation.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                var locked = false;
                try { ProductInstallation.InstallCore(root, source, services); } catch (IOException) { locked = true; }
                Assert(locked, "同时安装必须被互斥锁拒绝");
            }

            var rejectedPath = false;
            try { ProductInstallation.VersionExecutable(root, "..\\outside"); } catch (InvalidOperationException) { rejectedPath = true; }
            Assert(rejectedPath, "版本不能作为任意文件路径");
            var invalidSource = Path.Combine(testRoot, "corrupt.exe"); File.WriteAllText(invalidSource, "broken");
            var beforeInvalid = servicePath;
            var invalid = false;
            try { ProductInstallation.InstallCore(root, invalidSource, services); } catch { invalid = true; }
            Assert(invalid && servicePath == beforeInvalid && running, "坏包必须在停服务前拒绝");

            // Failure injection uses the real filesystem transaction, with only SCM calls replaced.
            var oldPath = Path.Combine(testRoot, "old-directory", ProductInstallation.PayloadName);
            var oldState = new InstalledProduct { ActiveVersion = "2.5.0", PreviousVersion = "2.4.0" };
            ProductInstallation.WriteAtomic(Path.Combine(root, "installed-product.json"), oldState);
            servicePath = oldPath; running = true;
            services.Verify = delegate(string exe) { if (exe == target) throw new IOException("new readiness failure"); };
            var rolledBack = false;
            try { ProductInstallation.InstallCore(root, source, services); }
            catch (InvalidOperationException error) { rolledBack = error.Message.Contains("已恢复原服务状态"); }
            Assert(rolledBack && servicePath == oldPath && running && ProductInstallation.ReadInstalled(root).ActiveVersion == "2.5.0",
                "健康检查失败必须恢复服务路径与固定入口");

            running = false;
            try { ProductInstallation.InstallCore(root, source, services); } catch (InvalidOperationException) { }
            Assert(!running && servicePath == oldPath, "原服务停止时回退必须恢复停止状态");
            running = true;
            services.Verify = delegate { throw new IOException("all readiness checks failed"); };
            var recoveryFailed = false;
            try { ProductInstallation.InstallCore(root, source, services); }
            catch (InvalidOperationException error) { recoveryFailed = error.Message.Contains("旧版恢复未通过验证"); }
            Assert(recoveryFailed && File.Exists(Path.Combine(root, "installation-pending.json")), "回退失败必须明确报警且保留恢复记录");
            services.Verify = delegate { };
            ProductInstallation.InstallCore(root, source, services);
            Assert(ProductInstallation.ReadInstalled(root).ActiveVersion == version && running,
                "再次安装必须先恢复未完成事务再执行切换");
            Assert(ProductInstallation.ReadInstalled(root).PreviousVersion == "2.5.0", "健康更新必须保留上一版本");

            // Commit/pointer persistence failure must also roll back SCM and the pointer.
            ProductInstallation.WriteAtomic(Path.Combine(root, "installed-product.json"), oldState);
            servicePath = oldPath;
            services.Verify = delegate(string exe)
            {
                if (exe == target) Directory.CreateDirectory(Path.Combine(root, "installed-product.json.new"));
            };
            services.Start = delegate(string exe)
            {
                servicePath = exe; running = true;
                var obstruction = Path.Combine(root, "installed-product.json.new");
                if (exe == oldPath && Directory.Exists(obstruction)) Directory.Delete(obstruction);
            };
            var commitFailed = false;
            try { ProductInstallation.InstallCore(root, source, services); }
            catch (InvalidOperationException error) { commitFailed = error.Message.Contains("已恢复原服务状态"); }
            Assert(commitFailed && servicePath == oldPath && ProductInstallation.ReadInstalled(root).ActiveVersion == "2.5.0", "入口提交失败也必须回退");

            var freshRoot = Path.Combine(testRoot, "failed-first-install");
            servicePath = null; running = false;
            services.Verify = delegate { throw new IOException("not ready"); };
            try { ProductInstallation.InstallCore(freshRoot, source, services); } catch (InvalidOperationException) { }
            Assert(servicePath == null && !running && ProductInstallation.ReadInstalled(freshRoot) == null, "首次安装失败必须撤销服务，不能宣称已安装");

            var cleanupRoot = Path.Combine(testRoot, "cleanup-install"); Directory.CreateDirectory(cleanupRoot);
            ProductInstallation.WriteAtomic(Path.Combine(cleanupRoot, "installed-product.json"), new InstalledProduct { ActiveVersion = "9.0.0", PreviousVersion = "8.0.0" });
            var oldRelease = ProductInstallation.VersionExecutable(cleanupRoot, version);
            Directory.CreateDirectory(Path.GetDirectoryName(oldRelease)); File.Copy(source, oldRelease);
            File.WriteAllText(Path.Combine(Path.GetDirectoryName(oldRelease), ".pms-release"), ProductInstallation.Hash(oldRelease));
            var unknown = Path.Combine(cleanupRoot, "releases", "unknown-user-data"); Directory.CreateDirectory(unknown);
            File.WriteAllText(Path.Combine(unknown, "keep.txt"), "do not delete");
            ProductInstallation.CleanupReleases(cleanupRoot, new List<string> { oldRelease });
            Assert(File.Exists(oldRelease), "仍被进程使用的版本不能删除");
            ProductInstallation.CleanupReleases(cleanupRoot, null);
            Assert(File.Exists(oldRelease), "无法确定进程路径时不能清理");
            ProductInstallation.CleanupReleases(cleanupRoot, new List<string>());
            Assert(!File.Exists(oldRelease) && File.Exists(Path.Combine(unknown, "keep.txt")), "只清理标记且验证通过的旧程序目录");

            var data = Path.Combine(testRoot, "preserved-data");
            var store = new ConfigurationStore(data); store.Load(); store.SetSecret("keep", "password");
            var configHash = ProductInstallation.Hash(Path.Combine(data, "connections.json"));
            var secretHash = ProductInstallation.Hash(Path.Combine(data, "secrets.dat"));
            var downloads = Path.Combine(data, "updates"); Directory.CreateDirectory(downloads);
            var obsolete = Path.Combine(downloads, "Pms.DataSyncAssistant.V2-2.0.0.exe"); File.WriteAllText(obsolete, "old package");
            File.SetLastWriteTimeUtc(obsolete, DateTime.UtcNow.AddDays(-8));
            var fresh = Path.Combine(downloads, "Pms.DataSyncAssistant.V2-2.1.0.exe"); File.WriteAllText(fresh, "fresh package");
            var localManifest = Path.Combine(downloads, "latest.json"); File.WriteAllText(localManifest, "manual manifest");
            ProductInstallation.CleanupDownloads(data, new List<string> { obsolete }, DateTime.UtcNow);
            Assert(File.Exists(obsolete), "仍被使用的旧下载包必须保留");
            ProductInstallation.CleanupDownloads(data, new List<string>(), DateTime.UtcNow);
            Assert(!File.Exists(obsolete) && File.Exists(fresh) && File.Exists(localManifest), "仅清理超过7天旧安装包，保留新包和离线清单");
            Assert(ProductInstallation.Hash(Path.Combine(data, "connections.json")) == configHash &&
                ProductInstallation.Hash(Path.Combine(data, "secrets.dat")) == secretHash && store.GetSecret("keep") == "password", "安装清理不得触碰配置与DPAPI密钥");
        }
    }
}
