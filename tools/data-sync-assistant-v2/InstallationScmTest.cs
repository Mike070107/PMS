using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

namespace Pms.DataSyncAssistant
{
    // Explicit diagnostic modes only. Never uses the production service name, ProgramData or any device/PMS connection.
    internal sealed class InstallationProbeService : ServiceBase
    {
        internal InstallationProbeService(string name) { ServiceName = name; }
        protected override void OnStart(string[] arguments)
        {
            var directory = AppDomain.CurrentDomain.BaseDirectory;
            if (!File.Exists(Path.Combine(directory, "fail-readiness")))
                File.WriteAllText(Path.Combine(directory, "test-ready.txt"), ProductInstallation.CurrentExecutable + "\n" + Process.GetCurrentProcess().Id);
        }
        protected override void OnStop()
        {
            var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "test-ready.txt");
            if (File.Exists(path)) File.Delete(path);
        }
    }

    internal static class InstallationScmTest
    {
        internal static void Run(string root)
        {
            var name = "PmsAssistantInstallTest_" + Guid.NewGuid().ToString("N");
            string actual = null;
            Action stop = delegate
            {
                if (!Exists(name)) return;
                using (var controller = new ServiceController(name))
                {
                    controller.Refresh();
                    if (controller.Status != ServiceControllerStatus.Stopped)
                    {
                        controller.Stop();
                        controller.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
                    }
                }
            };
            Action<string> start = delegate(string executable)
            {
                stop();
                var command = "\\\"" + executable + "\\\" --installation-probe-service " + name;
                if (!Exists(name)) Sc("create \"" + name + "\" binPath= \"" + command + "\" start= demand");
                else Sc("config \"" + name + "\" binPath= \"" + command + "\"");
                Sc("start \"" + name + "\"");
                using (var controller = new ServiceController(name)) controller.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
                actual = executable;
            };
            Action<string> verify = delegate(string executable)
            {
                var end = DateTime.UtcNow.AddSeconds(4);
                do
                {
                    var ready = Path.Combine(Path.GetDirectoryName(executable), "test-ready.txt");
                    if (File.Exists(ready))
                    {
                        var lines = File.ReadAllLines(ready);
                        if (lines.Length == 2 && ProductInstallation.SamePath(lines[0], executable))
                            using (var process = Process.GetProcessById(Int32.Parse(lines[1])))
                                if (!process.HasExited && ProductInstallation.SamePath(process.MainModule.FileName, executable)) return;
                    }
                    Thread.Sleep(100);
                } while (DateTime.UtcNow < end);
                throw new InvalidOperationException("test service did not publish ready evidence");
            };
            var services = new InstallationServices
            {
                ReadExecutable = delegate { return actual; }, IsRunning = delegate
                {
                    if (!Exists(name)) return false;
                    using (var controller = new ServiceController(name)) return controller.Status == ServiceControllerStatus.Running;
                },
                Start = start, Stop = stop, Verify = verify,
                Remove = delegate { if (Exists(name)) { stop(); Sc("delete \"" + name + "\""); } actual = null; }
            };
            Directory.CreateDirectory(root);
            var report = Path.Combine(root, "scm-test-result.txt");
            try
            {
                var managed = Path.Combine(root, "managed");
                ProductInstallation.InstallCore(managed, ProductInstallation.CurrentExecutable, services);
                var active = ProductInstallation.VersionExecutable(managed, UpdateManager.CurrentVersion);
                verify(active);
                var legacy = Path.Combine(root, "legacy", ProductInstallation.PayloadName);
                Directory.CreateDirectory(Path.GetDirectoryName(legacy)); File.Copy(ProductInstallation.CurrentExecutable, legacy, true);
                start(legacy); verify(legacy);
                File.WriteAllText(Path.Combine(Path.GetDirectoryName(active), "fail-readiness"), "injected");
                var rollback = false;
                try { ProductInstallation.InstallCore(managed, ProductInstallation.CurrentExecutable, services); }
                catch (InvalidOperationException error) { rollback = error.Message.Contains("已恢复原服务状态"); }
                if (!rollback || !ProductInstallation.SamePath(actual, legacy)) throw new InvalidOperationException("real SCM rollback failed");
                verify(legacy);
                stop();
                try { ProductInstallation.InstallCore(managed, ProductInstallation.CurrentExecutable, services); } catch (InvalidOperationException) { }
                if (services.IsRunning()) throw new InvalidOperationException("stopped state was not restored");
                File.Delete(Path.Combine(Path.GetDirectoryName(active), "fail-readiness"));
                ProductInstallation.InstallCore(managed, ProductInstallation.CurrentExecutable, services);
                verify(active);
                File.WriteAllText(report, "PASS real Windows SCM: create/start/ready, injected readiness failure, verified legacy rollback, original stopped-state restored, successful retry.\r\nService=" + name + "\r\nProduction service/config/secrets/devices untouched.\r\n");
            }
            finally
            {
                stop();
                if (Exists(name)) Sc("delete \"" + name + "\"");
            }
        }

        private static bool Exists(string name)
        {
            foreach (var service in ServiceController.GetServices())
                using (service) if (String.Equals(service.ServiceName, name, StringComparison.Ordinal)) return true;
            return false;
        }
        private static void Sc(string arguments)
        {
            using (var process = Process.Start(new ProcessStartInfo { FileName = "sc.exe", Arguments = arguments,
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true }))
            {
                var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                if (!process.WaitForExit(20000) || process.ExitCode != 0) throw new InvalidOperationException("SCM test command failed: " + arguments + " " + output);
            }
        }
    }
}
