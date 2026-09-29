using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;
using Microsoft.Win32;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessCardWindowsService : ServiceBase
    {
        private readonly AgentConfig _config;
        private readonly string _tokenPath;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private Thread _worker;

        public AccessCardWindowsService(AgentConfig config, string tokenPath)
        {
            _config = config;
            _tokenPath = tokenPath;
            ServiceName = WindowsServiceInstaller.ServiceName(config);
            CanStop = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            var token = SecretStore.Load(_tokenPath);
            var loop = new AgentLoop(_config, new AgentApiClient(_config, token));
            _worker = new Thread(delegate() { loop.Run(_stop); });
            _worker.IsBackground = true;
            _worker.Name = ServiceName + "-worker";
            _worker.Start();
        }

        protected override void OnStop()
        {
            _stop.Set();
            if (_worker != null) _worker.Join(10000);
        }
    }

    internal static class WindowsServiceInstaller
    {
        public static string ServiceName(AgentConfig config)
        {
            if (config.Kind == "legacy_sync") return "PmsDataSyncLegacy";
            if (config.Kind == "access_gateway") return "PmsDataSyncAccess";
            if (config.Kind == "parking_gateway") return "PmsDataSyncParking";
            return "PmsDataSyncIssuer";
        }

        public static void Install(AgentConfig config)
        {
            var serviceName = ServiceName(config);
            var executable = Process.GetCurrentProcess().MainModule.FileName;
            var displayName = "PMS 数据同步助手 - " + config.Name;
            // sc.exe expects the quotes around a path with spaces to be part of
            // the binPath value, hence the escaped inner quote pair.
            var binPath = "\\\"" + executable + "\\\"";

            var created = RunSc("create \"" + serviceName + "\" binPath= \"" + binPath + "\" start= auto DisplayName= \"" + displayName + "\"");
            if (created != 0)
                RequireSc("config \"" + serviceName + "\" binPath= \"" + binPath + "\" start= auto DisplayName= \"" + displayName + "\"");
            RequireSc("description \"" + serviceName + "\" \"PMS 本地数据同步助手，开机自动运行\"");
            RequireSc("failure \"" + serviceName + "\" reset= 86400 actions= restart/60000/restart/60000/restart/60000");
            RunSc("start \"" + serviceName + "\"");
            InstallTrayStartup(executable);
            Process.Start(new ProcessStartInfo { FileName = executable, Arguments = "--tray", UseShellExecute = true });
            Console.WriteLine("后台服务已安装并启动：" + displayName);
            Console.WriteLine("以后开机会自动运行，右下角托盘图标可查看状态，无需保留 PowerShell 窗口。");
        }

        public static void Uninstall(AgentConfig config)
        {
            var serviceName = ServiceName(config);
            RunSc("stop \"" + serviceName + "\"");
            RequireSc("delete \"" + serviceName + "\"");
            RemoveTrayStartup();
            Console.WriteLine("后台服务已删除：" + serviceName);
        }

        private static void InstallTrayStartup(string executable)
        {
            using (var key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
                key.SetValue("PmsDataSyncAssistant", "\"" + executable + "\" --tray");
        }

        private static void RemoveTrayStartup()
        {
            using (var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true))
                if (key != null) key.DeleteValue("PmsDataSyncAssistant", false);
        }

        private static void RequireSc(string arguments)
        {
            if (RunSc(arguments) != 0)
                throw new InvalidOperationException("后台服务操作失败。请右键 PowerShell，选择“以管理员身份运行”后重试。");
        }

        private static int RunSc(string arguments)
        {
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true
            });
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
