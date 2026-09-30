using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.ServiceProcess;
using System.Threading;
using System.Web.Script.Serialization;

namespace Pms.DataSyncAssistant
{
    internal sealed class UnifiedWindowsService : ServiceBase
    {
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private Thread _worker;

        public UnifiedWindowsService()
        {
            ServiceName = UnifiedServiceManager.ServiceName;
            CanStop = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            _worker = new Thread(RunLoop) { IsBackground = true, Name = "PMS-data-connection-monitor" };
            _worker.Start();
        }

        protected override void OnStop()
        {
            _stop.Set();
            if (_worker != null) _worker.Join(10000);
        }

        private void RunLoop()
        {
            while (!_stop.WaitOne(0))
            {
                WriteHealth(CheckConnections());
                if (_stop.WaitOne(TimeSpan.FromSeconds(30))) break;
            }
        }

        private static object CheckConnections()
        {
            var store = new ConfigurationStore();
            var configuration = store.Load();
            var checks = new List<object>();
            foreach (var item in configuration.Connections.Where(value => value.Enabled))
            {
                try
                {
                    var result = ConnectionTester.Test(item, store.GetSecret("connection:" + item.Id + ":password"));
                    checks.Add(new { id = item.Id, name = item.Name, healthy = result.Success, message = result.Summary });
                }
                catch (Exception exception)
                {
                    checks.Add(new { id = item.Id, name = item.Name, healthy = false, message = exception.Message });
                }
            }
            return new { checkedAt = DateTimeOffset.Now.ToString("o"), connections = checks };
        }

        private static void WriteHealth(object value)
        {
            var store = new ConfigurationStore();
            var path = Path.Combine(store.RootPath, "health.json");
            var temporary = path + ".new";
            File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(value));
            if (File.Exists(path)) File.Replace(temporary, path, path + ".previous", true);
            else File.Move(temporary, path);
        }
    }

    internal static class UnifiedServiceManager
    {
        public const string ServiceName = "PmsDataSyncAssistant";

        public static void Install()
        {
            var executable = Process.GetCurrentProcess().MainModule.FileName;
            var command = "\\\"" + executable + "\\\" --service";
            if (RunSc("create \"" + ServiceName + "\" binPath= \"" + command + "\" start= auto DisplayName= \"PMS 数据同步助手\"") != 0)
                RequireSc("config \"" + ServiceName + "\" binPath= \"" + command + "\" start= auto DisplayName= \"PMS 数据同步助手\"");
            RequireSc("description \"" + ServiceName + "\" \"连接 PMS 与本机数据库、门禁和发卡设备\"");
            RequireSc("failure \"" + ServiceName + "\" reset= 86400 actions= restart/60000/restart/60000/restart/60000");
            RunSc("start \"" + ServiceName + "\"");
        }

        public static void Uninstall()
        {
            RunSc("stop \"" + ServiceName + "\"");
            if (RunSc("delete \"" + ServiceName + "\"") != 0 && Exists())
                throw new InvalidOperationException("后台服务未能卸载，请确认使用管理员权限运行");
        }

        public static bool Exists()
        {
            return ServiceController.GetServices().Any(item => String.Equals(item.ServiceName, ServiceName, StringComparison.OrdinalIgnoreCase));
        }

        public static void RunElevated(string argument)
        {
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = Process.GetCurrentProcess().MainModule.FileName,
                Arguments = argument,
                UseShellExecute = true,
                Verb = "runas"
            });
            process.WaitForExit();
            if (process.ExitCode != 0) throw new InvalidOperationException("操作未完成，请确认管理员授权提示");
        }

        private static void RequireSc(string arguments)
        {
            if (RunSc(arguments) != 0) throw new InvalidOperationException("Windows 后台服务操作失败");
        }

        private static int RunSc(string arguments)
        {
            var process = Process.Start(new ProcessStartInfo { FileName = "sc.exe", Arguments = arguments, UseShellExecute = false, CreateNoWindow = true });
            if (!process.WaitForExit(20000)) { try { process.Kill(); } catch { } throw new InvalidOperationException("Windows 服务操作超时"); }
            return process.ExitCode;
        }
    }
}
