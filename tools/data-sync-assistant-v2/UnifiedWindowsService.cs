using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.ServiceProcess;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Pms.DataSyncAssistant
{
    internal sealed class UnifiedWindowsService : ServiceBase
    {
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private Thread _worker;
        private readonly List<ConnectionAgentRuntime> _runtimes = new List<ConnectionAgentRuntime>();

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
            var store = new ConfigurationStore();
            var configuration = store.Load();
            foreach (var item in configuration.Connections.Where(value => value.Enabled))
            {
                var runtime = new ConnectionAgentRuntime(item, configuration.Host, store, _stop);
                _runtimes.Add(runtime);
                runtime.Start();
            }
            while (!_stop.WaitOne(0))
            {
                WriteHealth(CheckConnections(store, configuration, _runtimes));
                if (_stop.WaitOne(TimeSpan.FromSeconds(30))) break;
            }
            foreach (var runtime in _runtimes) runtime.Stop(10000);
        }

        private static object CheckConnections(ConfigurationStore store, AssistantConfiguration configuration, IEnumerable<ConnectionAgentRuntime> runtimes)
        {
            var checks = new List<object>();
            var runtimeStates = runtimes.ToDictionary(value => value.Snapshot().Id, value => value.Snapshot());
            foreach (var item in configuration.Connections.Where(value => value.Enabled))
            {
                try
                {
                    var result = ConnectionTester.Test(item, store.GetSecret("connection:" + item.Id + ":password"));
                    ConnectionAgentSnapshot agent;
                    runtimeStates.TryGetValue(item.Id, out agent);
                    checks.Add(new
                    {
                        id = item.Id,
                        name = item.Name,
                        healthy = result.Success && agent != null && agent.Connected,
                        localHealthy = result.Success,
                        pmsConnected = agent != null && agent.Connected,
                        message = agent == null ? result.Summary : result.Summary + "；" + agent.Message,
                        updatedAt = agent == null ? null : agent.UpdatedAt
                    });
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
            InstallTrayStartup(executable);
            Process.Start(new ProcessStartInfo { FileName = executable, Arguments = "--tray", UseShellExecute = true });
        }

        public static void Uninstall()
        {
            RunSc("stop \"" + ServiceName + "\"");
            if (RunSc("delete \"" + ServiceName + "\"") != 0 && Exists())
                throw new InvalidOperationException("后台服务未能卸载，请确认使用管理员权限运行");
            RemoveTrayStartup();
        }

        public static void UpgradeFromLegacy()
        {
            var store = new ConfigurationStore();
            var configuration = store.Load();
            new LegacyConfigurationMigrator(store).ImportKnownLocations(configuration);
            configuration = store.Load();
            var enabled = configuration.Connections.Where(item => item.Enabled).ToList();
            if (enabled.Count == 0) throw new InvalidOperationException("没有找到可升级的旧版连接配置，请先打开助手完成连接设置");

            foreach (var item in enabled)
            {
                var password = store.GetSecret(ConnectionAgentRuntime.PasswordKey(item));
                var local = ConnectionTester.Test(item, password);
                if (!local.Success) throw new InvalidOperationException(item.Name + "：" + local.Summary);
                ConnectionAgentRuntime.TestPms(item, configuration.Host, store);
            }

            var legacyServices = enabled.Select(item => LegacyServiceName(item.Type))
                .Where(name => name != null && ServiceExists(name)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            foreach (var service in legacyServices) StopService(service);
            try
            {
                var healthPath = Path.Combine(store.RootPath, "health.json");
                if (File.Exists(healthPath)) File.Delete(healthPath);
                Install();
                if (!WaitForHealthy(store, enabled.Select(item => item.Id).ToArray(), TimeSpan.FromSeconds(55)))
                    throw new InvalidOperationException("新版服务启动后未能在规定时间内同时通过本地检测和 PMS 心跳");
                foreach (var service in legacyServices) RunSc("delete \"" + service + "\"");
            }
            catch (Exception exception)
            {
                try { Uninstall(); } catch { }
                foreach (var service in legacyServices) RunSc("start \"" + service + "\"");
                throw new InvalidOperationException("新版验证失败，已恢复旧版服务。原因：" + exception.Message, exception);
            }
        }

        public static bool Exists()
        {
            return ServiceController.GetServices().Any(item => String.Equals(item.ServiceName, ServiceName, StringComparison.OrdinalIgnoreCase));
        }

        private static bool WaitForHealthy(ConfigurationStore store, string[] expectedIds, TimeSpan timeout)
        {
            var path = Path.Combine(store.RootPath, "health.json");
            var deadline = DateTime.UtcNow.Add(timeout);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    if (File.Exists(path))
                    {
                        var root = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
                        var values = root == null || !root.ContainsKey("connections") ? null : root["connections"] as object[];
                        if (values != null)
                        {
                            var healthy = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            foreach (var value in values)
                            {
                                var item = value as Dictionary<string, object>;
                                if (item == null || !item.ContainsKey("id")) continue;
                                if (item.ContainsKey("healthy") && Convert.ToBoolean(item["healthy"])) healthy.Add(Convert.ToString(item["id"]));
                            }
                            if (expectedIds.All(healthy.Contains)) return true;
                        }
                    }
                }
                catch { }
                Thread.Sleep(1000);
            }
            return false;
        }

        private static string LegacyServiceName(string type)
        {
            if (type == ConnectionTypes.LegacyAccess) return "PmsDataSyncLegacy";
            if (type == ConnectionTypes.BuildingAccess) return "PmsDataSyncAccess";
            if (type == ConnectionTypes.Parking) return "PmsDataSyncParking";
            if (type == ConnectionTypes.CardReader) return "PmsDataSyncIssuer";
            return null;
        }

        private static bool ServiceExists(string serviceName)
        {
            return ServiceController.GetServices().Any(item => String.Equals(item.ServiceName, serviceName, StringComparison.OrdinalIgnoreCase));
        }

        private static void StopService(string serviceName)
        {
            RunSc("stop \"" + serviceName + "\"");
            try
            {
                using (var service = new ServiceController(serviceName))
                {
                    service.Refresh();
                    if (service.Status != ServiceControllerStatus.Stopped)
                        service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
                }
            }
            catch (Exception exception) { throw new InvalidOperationException("无法停止旧版服务 " + serviceName + "：" + exception.Message, exception); }
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
    }
}
