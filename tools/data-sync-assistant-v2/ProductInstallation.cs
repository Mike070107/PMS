using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Pms.DataSyncAssistant
{
    internal sealed class InstalledProduct
    {
        public string ActiveVersion { get; set; }
        public string PreviousVersion { get; set; }
        public string PreviousExecutable { get; set; }
    }

    internal sealed class InstallationJournal
    {
        public InstalledProduct Previous { get; set; }
        public string PreviousExecutable { get; set; }
        public bool HadService { get; set; }
        public bool WasRunning { get; set; }
    }

    // The transaction is shared by the installer, old update-runner protocol and service updater.
    // Hooks isolate SCM for fault-injection tests; production never substitutes database operations.
    internal sealed class InstallationServices
    {
        internal Func<string> ReadExecutable;
        internal Func<bool> IsRunning;
        internal Action<string> Start;
        internal Action Stop;
        internal Action Remove;
        internal Action<string> Verify;
    }

    internal static class ProductInstallation
    {
        internal const string PayloadName = "Pms.DataSyncAssistant.V2.exe";
        internal const string LauncherName = "Pms.DataSyncAssistant.exe";
        internal static string Root
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PMS", "DataSyncAssistant"); }
        }
        internal static string Launcher { get { return Path.Combine(Root, LauncherName); } }
        internal static string CurrentExecutable { get { return Process.GetCurrentProcess().MainModule.FileName; } }
        internal static string ShellIntegrationWarning { get; private set; }

        internal static bool SamePath(string left, string right)
        {
            return !String.IsNullOrWhiteSpace(left) && !String.IsNullOrWhiteSpace(right) &&
                String.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
        }

        internal static string VersionExecutable(string root, string version)
        {
            Version parsed;
            if (!Version.TryParse(version, out parsed) || parsed.Build < 0 || parsed.ToString(3) != version)
                throw new InvalidOperationException("安装记录的版本无效，拒绝使用路径：" + version);
            return Path.Combine(root, "releases", version, PayloadName);
        }

        internal static InstalledProduct ReadInstalled(string root)
        {
            var path = Path.Combine(root, "installed-product.json");
            if (!File.Exists(path)) return null;
            return new JavaScriptSerializer().Deserialize<InstalledProduct>(File.ReadAllText(path));
        }

        internal static bool IsManagedExecutable(string executable)
        {
            var state = ReadInstalled(Root);
            return state != null && (SamePath(executable, VersionExecutable(Root, state.ActiveVersion)) ||
                (!String.IsNullOrEmpty(state.PreviousVersion) && SamePath(executable, VersionExecutable(Root, state.PreviousVersion))));
        }

        internal static bool ForwardLauncher(string[] arguments)
        {
            if (!SamePath(CurrentExecutable, Launcher)) return false;
            var state = ReadInstalled(Root);
            if (state == null) throw new InvalidOperationException("助手安装尚未完成，请重新运行下载的安装程序。");
            var executable = VersionExecutable(Root, state.ActiveVersion);
            VerifyPayload(executable, state.ActiveVersion);
            Process.Start(new ProcessStartInfo { FileName = executable,
                Arguments = String.Join(" ", arguments.Select(Quote).ToArray()), UseShellExecute = true });
            return true;
        }

        internal static void Install(string source)
        {
            var services = new InstallationServices
            {
                ReadExecutable = UnifiedServiceManager.ReadServiceExecutable,
                IsRunning = UnifiedServiceManager.IsRunning,
                Start = delegate(string path) { UnifiedServiceManager.ConfigureAndStart(path); },
                Stop = UnifiedServiceManager.Stop,
                Remove = UnifiedServiceManager.Uninstall,
                Verify = VerifyServiceReady
            };
            InstallCore(Root, source, services);
            // This is outside the commit boundary: shell integration/cleanup cannot invalidate a healthy upgrade.
            ShellIntegrationWarning = null;
            try { InstallShortcuts(); UnifiedServiceManager.InstallTrayStartupForCurrentUser(Launcher); }
            catch (Exception error)
            {
                ShellIntegrationWarning = "快捷方式/登录托盘入口设置未完成：" + error.Message + "；请暂时从固定入口打开：" + Launcher;
                Trace.WriteLine(ShellIntegrationWarning);
            }
            try
            {
                using (var cleanupLock = new FileStream(Path.Combine(Root, "installation.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
                {
                    var loaded = LoadedExecutables();
                    var state = ReadInstalled(Root);
                    if (loaded != null && state != null && !String.IsNullOrWhiteSpace(state.PreviousExecutable)) loaded.Add(state.PreviousExecutable);
                    var warnings = CleanupReleases(Root, loaded);
                    warnings.AddRange(CleanupDownloads(new ConfigurationStore().RootPath, loaded, DateTime.UtcNow));
                    File.WriteAllText(Path.Combine(Root, "cleanup-warnings.txt"), String.Join(Environment.NewLine, warnings.ToArray()));
                }
            }
            catch (Exception error) { Trace.WriteLine("助手已安装，旧包清理延后：" + error.Message); }
        }

        internal static void InstallCore(string root, string source, InstallationServices services)
        {
            EnsureOrdinaryPath(root);
            Directory.CreateDirectory(root);
            using (var installationLock = new FileStream(Path.Combine(root, "installation.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                var statePath = Path.Combine(root, "installed-product.json");
                var journalPath = Path.Combine(root, "installation-pending.json");
                if (File.Exists(journalPath))
                {
                    var pending = new JavaScriptSerializer().Deserialize<InstallationJournal>(File.ReadAllText(journalPath));
                    Restore(root, pending, services);
                    File.Delete(journalPath);
                }
                var previous = ReadInstalled(root);
                var version = FileVersionInfo.GetVersionInfo(source).FileVersion;
                version = new Version(version).ToString(3);
                if (previous != null && new Version(version) < new Version(previous.ActiveVersion))
                    throw new InvalidOperationException("不允许安装较旧版本；请使用最新安装程序。");
                var target = VersionExecutable(root, version);
                EnsureOrdinaryPath(Path.GetDirectoryName(target));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                if (File.Exists(target))
                {
                    if (Hash(source) != Hash(target)) throw new InvalidOperationException("同版本程序内容不一致，已停止覆盖；请发布新版本号。");
                }
                else
                {
                    File.Copy(source, target + ".new", true);
                    if (Hash(source) != Hash(target + ".new")) throw new IOException("安装复制校验失败");
                    File.Move(target + ".new", target);
                }
                VerifyPayload(target, version);
                File.WriteAllText(Path.Combine(Path.GetDirectoryName(target), ".pms-release"), Hash(target));
                var launcher = Path.Combine(root, LauncherName);
                if (!File.Exists(launcher)) File.Copy(target, launcher);
                var oldExecutable = services.ReadExecutable();
                var journal = new InstallationJournal { Previous = previous, PreviousExecutable = oldExecutable,
                    HadService = !String.IsNullOrWhiteSpace(oldExecutable), WasRunning = services.IsRunning() };
                WriteAtomic(journalPath, journal);
                try
                {
                    services.Start(target);
                    services.Verify(target);
                    var oldVersion = previous == null ? null : previous.ActiveVersion;
                    WriteAtomic(statePath, new InstalledProduct { ActiveVersion = version,
                        PreviousVersion = oldVersion == version ? previous.PreviousVersion : oldVersion,
                        PreviousExecutable = oldVersion == version ? previous.PreviousExecutable : oldExecutable });
                    File.Delete(journalPath);
                }
                catch (Exception failure)
                {
                    try
                    {
                        Restore(root, journal, services);
                        File.Delete(journalPath);
                    }
                    catch (Exception rollback)
                    {
                        throw new InvalidOperationException("新版安装失败，且旧版恢复未通过验证！请勿反复安装，保留安装目录联系维护人员。安装错误：" +
                            failure.Message + "；恢复错误：" + rollback.Message, new AggregateException(failure, rollback));
                    }
                    throw new InvalidOperationException(journal.HadService ? "新版安装失败，已恢复原服务状态：" + failure.Message :
                        "新版安装失败，已撤销新建服务，配置与密码未删除：" + failure.Message, failure);
                }
            }
        }

        private static void Restore(string root, InstallationJournal journal, InstallationServices services)
        {
            if (journal == null) throw new InvalidOperationException("安装恢复记录已损坏");
            services.Stop();
            if (journal.HadService)
            {
                services.Start(journal.PreviousExecutable);
                // Older V2 releases have no executable readiness field: SCM Running is the available fallback evidence.
                if (journal.Previous != null) services.Verify(journal.PreviousExecutable);
                if (!journal.WasRunning) services.Stop();
            }
            else services.Remove();
            var path = Path.Combine(root, "installed-product.json");
            if (journal.Previous == null) { if (File.Exists(path)) File.Delete(path); }
            else WriteAtomic(path, journal.Previous);
        }

        internal static void VerifyPayload(string executable, string version)
        {
            EnsureOrdinaryPath(executable);
            if (!File.Exists(executable) || new Version(FileVersionInfo.GetVersionInfo(executable).FileVersion).ToString(3) != version)
                throw new InvalidOperationException("安装程序丢失或文件版本不一致：" + executable);
            var marker = Path.Combine(Path.GetDirectoryName(executable), ".pms-release");
            if (File.Exists(marker) && File.ReadAllText(marker) != Hash(executable))
                throw new InvalidOperationException("安装程序校验失败，请重新下载安装包");
        }

        internal static void VerifyServiceReady(string executable)
        {
            var verificationStarted = DateTimeOffset.Now;
            var deadline = DateTime.UtcNow.AddSeconds(35);
            while (DateTime.UtcNow < deadline)
            {
                if (UnifiedServiceManager.IsRunning() && HasFreshReadyEvidence(
                    Path.Combine(new ConfigurationStore().RootPath, "health.json"), executable, verificationStarted)) return;
                Thread.Sleep(250);
            }
            throw new InvalidOperationException("服务未在 35 秒内提交本机就绪证据（不等同于 PMS/设备在线）");
        }

        internal static bool HasFreshReadyEvidence(string path, string executable, DateTimeOffset verificationStarted)
        {
            try
            {
                var value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                var checkedAt = DateTimeOffset.Parse(Convert.ToString(value["checkedAt"]));
                if (!SamePath(Convert.ToString(value["executable"]), executable) ||
                    Convert.ToString(value["version"]) != new Version(FileVersionInfo.GetVersionInfo(executable).FileVersion).ToString(3) || checkedAt < verificationStarted ||
                    checkedAt > DateTimeOffset.Now.AddSeconds(5) || DateTimeOffset.Now - checkedAt > TimeSpan.FromSeconds(10)) return false;
                using (var process = Process.GetProcessById(Convert.ToInt32(value["processId"])))
                    return !process.HasExited && SamePath(process.MainModule.FileName, executable);
            }
            catch { return false; }
        }

        internal static void WriteAtomic(string path, object value)
        {
            File.WriteAllText(path + ".new", new JavaScriptSerializer().Serialize(value));
            if (File.Exists(path)) File.Replace(path + ".new", path, null);
            else File.Move(path + ".new", path);
        }

        internal static void EnsureOrdinaryPath(string path)
        {
            var current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("拒绝操作链接/重解析路径：" + current);
                current = Path.GetDirectoryName(current);
            }
        }

        internal static string Hash(string path)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(path))
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        internal static List<string> LoadedExecutables()
        {
            var result = new List<string>();
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                {
                    if (!process.ProcessName.StartsWith("Pms.DataSyncAssistant", StringComparison.OrdinalIgnoreCase)) continue;
                    try { result.Add(process.MainModule.FileName); }
                    catch { return null; } // Unknown running image: defer all cleanup, never guess.
                }
            }
            return result;
        }

        internal static List<string> CleanupReleases(string root, IList<string> loaded)
        {
            var warnings = new List<string>();
            if (loaded == null || File.Exists(Path.Combine(root, "installation-pending.json"))) return warnings;
            var state = ReadInstalled(root);
            var releases = Path.Combine(root, "releases");
            if (state == null || !Directory.Exists(releases)) return warnings;
            EnsureOrdinaryPath(releases);
            foreach (var directory in Directory.GetDirectories(releases))
            {
                try
                {
                    EnsureOrdinaryPath(directory);
                    var version = Path.GetFileName(directory);
                    var exe = VersionExecutable(root, version); // rejects non-version directories
                    if (version == state.ActiveVersion || version == state.PreviousVersion || loaded.Any(path => SamePath(path, exe))) continue;
                    var marker = Path.Combine(directory, ".pms-release");
                    if (!File.Exists(marker) || Directory.GetDirectories(directory).Length != 0 ||
                        Directory.GetFiles(directory).Any(file => !SamePath(file, exe) && !SamePath(file, marker))) continue;
                    VerifyPayload(exe, version);
                    // Only these two known artifacts, never recursive deletion or configuration/secret paths.
                    File.Delete(exe); File.Delete(marker); Directory.Delete(directory);
                }
                catch (Exception error) { warnings.Add("保留旧程序目录 " + directory + "：" + error.Message); }
            }
            return warnings;
        }

        internal static List<string> CleanupDownloads(string dataRoot, IList<string> loaded, DateTime now)
        {
            var warnings = new List<string>();
            if (loaded == null) return warnings;
            // Legacy staging directories only. Never visit other data-root directories.
            foreach (var name in new[] { "updates", "releases" })
            {
                var path = Path.Combine(dataRoot, name);
                if (!Directory.Exists(path)) continue;
                try
                {
                    EnsureOrdinaryPath(path);
                    var files = new List<string>(Directory.GetFiles(path));
                    if (name == "releases")
                        foreach (var directory in Directory.GetDirectories(path))
                        {
                            Version version;
                            if (!Version.TryParse(Path.GetFileName(directory), out version)) continue;
                            EnsureOrdinaryPath(directory);
                            files.AddRange(Directory.GetFiles(directory));
                        }
                    foreach (var file in files)
                    {
                        EnsureOrdinaryPath(file);
                        var fileName = Path.GetFileName(file);
                        if (!(fileName == PayloadName || (fileName.StartsWith("Pms.DataSyncAssistant.V2-", StringComparison.Ordinal) &&
                            (fileName.EndsWith(".exe", StringComparison.Ordinal) || fileName.EndsWith(".download", StringComparison.Ordinal))) ||
                            fileName == PayloadName + ".download")) continue;
                        if (File.GetLastWriteTimeUtc(file) > now.AddDays(-7) || loaded.Any(image => SamePath(image, file))) continue;
                        File.Delete(file);
                    }
                }
                catch (Exception error) { warnings.Add("旧下载缓存暂未清理：" + error.Message); }
            }
            return warnings;
        }

        private static void InstallShortcuts()
        {
            // All users see the same fixed launcher; UAC's alternate admin identity must not own the only shortcut.
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms) })
            {
                dynamic shortcut = shell.CreateShortcut(Path.Combine(folder, "PMS 数据同步助手.lnk"));
                shortcut.TargetPath = Launcher;
                shortcut.WorkingDirectory = Root;
                shortcut.Description = "PMS 数据同步助手（固定启动入口）";
                shortcut.Save();
            }
            using (var key = Registry.LocalMachine.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
                key.SetValue("PmsDataSyncAssistant", Quote(Launcher) + " --tray");
        }

        internal static string Quote(string value)
        {
            // Windows CommandLineToArgvW rules: double backslashes before a quote or closing delimiter.
            var result = new System.Text.StringBuilder("\"");
            var slashes = 0;
            foreach (var character in value ?? String.Empty)
            {
                if (character == '\\') { slashes++; continue; }
                result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
                result.Append(character); slashes = 0;
            }
            result.Append('\\', slashes * 2); result.Append('"');
            return result.ToString();
        }
    }
}
