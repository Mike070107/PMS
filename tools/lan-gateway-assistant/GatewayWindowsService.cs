using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.Linq;
using System.ServiceProcess;
using System.Threading;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewayWindowsService : ServiceBase
    {
        private GatewayRuntime _runtime;
        public GatewayWindowsService() { ServiceName = GatewayServiceManager.ServiceName; CanStop = true; AutoLog = true; }
        protected override void OnStart(string[] args) { _runtime = new GatewayRuntime(new GatewayConfigurationStore()); _runtime.Start(); }
        protected override void OnStop() { if (_runtime != null) { _runtime.Dispose(); _runtime = null; } }
    }

    internal static class GatewayServiceManager
    {
        public const string ServiceName = "PmsLanGatewayAssistant";
        private const string LegacyTaskName = "PMS Domestic Gateway";
        public static bool Exists() { return ServiceController.GetServices().Any(item => String.Equals(item.ServiceName, ServiceName, StringComparison.OrdinalIgnoreCase)); }
        public static bool IsRunning()
        {
            try { using (var service = new ServiceController(ServiceName)) { service.Refresh(); return service.Status == ServiceControllerStatus.Running; } } catch { return false; }
        }
        public static void Install()
        {
            var store = new GatewayConfigurationStore(); var configuration = store.Load();
            store.WriteRuntimeToken();
            System.IO.File.WriteAllText(store.FrpcConfigPath, FrpConfiguration.Build(configuration, store), new System.Text.UTF8Encoding(false));
            var current = Process.GetCurrentProcess().MainModule.FileName; var sibling = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(current), "frpc.exe");
            var installedExecutable = store.InstalledExecutablePath;
            var legacyTaskExists = LegacyTaskExists();
            var serviceWasRunning = IsRunning();
            if (legacyTaskExists) RunSchtasks("/End /TN \"" + LegacyTaskName + "\"");
            if (serviceWasRunning) Stop();
            try
            {
                if (!System.IO.File.Exists(store.FrpcPath)) store.InstallFrpc(sibling);
                if (!String.Equals(System.IO.Path.GetFullPath(current), System.IO.Path.GetFullPath(installedExecutable), StringComparison.OrdinalIgnoreCase))
                    System.IO.File.Copy(current, installedExecutable, true);
                if (!Exists()) RequireSc("create \"" + ServiceName + "\" binPath= \"\\\"" + installedExecutable + "\\\" --service\" start= auto DisplayName= \"PMS 内网应用连接助手\"");
                else RequireSc("config \"" + ServiceName + "\" binPath= \"\\\"" + installedExecutable + "\\\" --service\" start= auto");
                RequireSc("description \"" + ServiceName + "\" \"PMS 内网应用安全连接与转发服务\"");
                RequireSc("failure \"" + ServiceName + "\" reset= 86400 actions= restart/60000/restart/60000/restart/60000");
                RequireSc("failureflag \"" + ServiceName + "\" 1"); Start();
                if (legacyTaskExists) RunSchtasks("/Change /TN \"" + LegacyTaskName + "\" /Disable");
                InstallStartup(installedExecutable);
            }
            catch
            {
                if (serviceWasRunning && Exists()) { try { Start(); } catch { } }
                if (legacyTaskExists) RunSchtasks("/Run /TN \"" + LegacyTaskName + "\"");
                throw;
            }
        }
        public static void Uninstall() { Stop(); if (Exists()) RequireSc("delete \"" + ServiceName + "\""); RemoveStartup(); }
        public static void Restart() { Stop(); Start(); }
        public static void Start()
        {
            using (var service = new ServiceController(ServiceName)) { service.Refresh(); if (service.Status == ServiceControllerStatus.Running) return; service.Start(); service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20)); }
        }
        public static void Stop()
        {
            if (!Exists()) return; using (var service = new ServiceController(ServiceName)) { service.Refresh(); if (service.Status == ServiceControllerStatus.Stopped) return; service.Stop(); service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20)); }
        }
        public static void RunElevated(string argument)
        {
            var process = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = argument, UseShellExecute = true, Verb = "runas" }); process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("操作未完成，请确认 Windows 管理员授权提示");
        }
        private static int RunSc(string arguments) { var p = Process.Start(new ProcessStartInfo { FileName = "sc.exe", Arguments = arguments, UseShellExecute = false, CreateNoWindow = true }); if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } throw new InvalidOperationException("Windows 后台服务操作超时"); } return p.ExitCode; }
        private static void RequireSc(string arguments) { if (RunSc(arguments) != 0) throw new InvalidOperationException("Windows 后台服务操作失败：" + arguments); }
        private static bool LegacyTaskExists() { return RunSchtasks("/Query /TN \"" + LegacyTaskName + "\"") == 0; }
        private static int RunSchtasks(string arguments)
        {
            try
            {
                var p = Process.Start(new ProcessStartInfo { FileName = "schtasks.exe", Arguments = arguments, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
                if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } return -1; }
                return p.ExitCode;
            }
            catch { return -1; }
        }
        private static void InstallStartup(string executable) { using (var key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")) key.SetValue("PmsLanGatewayAssistant", "\"" + executable + "\" --tray"); }
        private static void RemoveStartup() { using (var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true)) if (key != null) key.DeleteValue("PmsLanGatewayAssistant", false); }
    }
}
