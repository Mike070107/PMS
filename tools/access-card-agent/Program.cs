using System;
using System.IO;
using System.Net;
using System.ServiceProcess;
using System.Windows.Forms;

namespace Pms.AccessCardAgent
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            try
            {
                // .NET 4 在旧 Windows 上可能默认协商 TLS 1.0；PMS 公网接口要求 TLS 1.2。
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
                var root = AppDomain.CurrentDomain.BaseDirectory;
                var configPath = Path.Combine(root, "agent.config.json");
                var tokenPath = Path.Combine(root, "agent.token.dat");
                var databasePasswordPath = Path.Combine(root, "legacy-db-password.dat");
                var icCardPasswordPath = Path.Combine(root, "iccard-db-password.dat");
                var parkingPasswordPath = Path.Combine(root, "parking-db-password.dat");
                if (!Environment.UserInteractive)
                {
                    ServiceBase.Run(new AccessCardWindowsService(AgentConfig.Load(configPath), tokenPath));
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--tray")
                {
                    using (var instance = SingleInstance.TryEnter("Tray"))
                    {
                        if (instance == null) return 0;
                        TrayApplication.HideConsoleWindow();
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        Application.Run(new AgentTrayContext(AgentConfig.Load(configPath)));
                    }
                    return 0;
                }
                if (args.Length == 0)
                {
                    using (var instance = SingleInstance.TryEnter("Settings"))
                    {
                        if (instance == null)
                        {
                            MessageBox.Show("设置窗口已经打开，请在任务栏中查看。", "PMS 数据同步助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
                            return 0;
                        }
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        Application.Run(new AgentManagerForm(root));
                    }
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--self-test")
                {
                    int sequence;
                    if (!LegacyDatabase.TrySequence("228/5/301", "228/05/301/6", out sequence) || sequence != 6)
                        throw new InvalidOperationException("旧库房号序号解析测试失败");
                    if (LegacyDatabase.TrySequence("228/5/301", "228/5/30/6", out sequence))
                        throw new InvalidOperationException("相似房号隔离测试失败");
                    if (AgentConfig.NormalizeAgentId("legacy_sync-legacy_sync-a8c6fe8239867d2e") != "legacy_sync-a8c6fe8239867d2e")
                        throw new InvalidOperationException("代理 ID 粘贴容错测试失败");
                    if (AgentConfig.NormalizeAgentId("parking_gateway-parking_gateway-a8c6fe8239867d2e") != "parking_gateway-a8c6fe8239867d2e")
                        throw new InvalidOperationException("停车网关代理 ID 粘贴容错测试失败");
                    var slashVariants = ParkingDatabase.SearchVariantsForTest("228/5/301");
                    if (!slashVariants.Contains("228/5/301") || !slashVariants.Contains("228-5-301"))
                        throw new InvalidOperationException("停车房号斜杠转横线测试失败");
                    var dashVariants = ParkingDatabase.SearchVariantsForTest("198-5-201");
                    if (!dashVariants.Contains("198-5-201") || !dashVariants.Contains("198/5/201"))
                        throw new InvalidOperationException("停车房号横线转斜杠测试失败");
                    if (ParkingDatabase.EscapeLikeForTest("A%_~[") != "A~%~_~~~[")
                        throw new InvalidOperationException("停车查询通配符转义测试失败");
                    using (var first = SingleInstance.TryEnter("SelfTest"))
                    using (var second = SingleInstance.TryEnter("SelfTest"))
                    {
                        if (first == null || second != null)
                            throw new InvalidOperationException("单实例锁测试失败");
                    }
                    Console.WriteLine("自检通过：门禁房号隔离、停车房号格式和查询通配符转义正常");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--install-token")
                {
                    Console.Write("粘贴一次性代理密钥（输入不会显示）：");
                    SecretStore.Save(tokenPath, SecretStore.ReadHidden());
                    Console.WriteLine("代理密钥已使用 Windows DPAPI 加密保存。");
                    return 0;
                }
                if (args.Length > 1 && args[0] == "--install-agent")
                {
                    Console.Write("粘贴一次性代理密钥（输入不会显示）：");
                    var credential = SecretStore.ReadHidden();
                    AgentConfig.InstallAgentId(configPath, args[1]);
                    SecretStore.Save(tokenPath, credential);
                    Console.WriteLine("代理 ID 已写入配置，密钥已使用 Windows DPAPI 加密保存。");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--install-db-password")
                {
                    Console.Write("粘贴旧库密码（输入不会显示）：");
                    SecretStore.Save(databasePasswordPath, SecretStore.ReadHidden());
                    Console.WriteLine("旧库密码已使用 Windows DPAPI 加密保存。");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--install-iccard-password")
                {
                    Console.Write("粘贴 iCCard MDB 密码（输入不会显示）：");
                    SecretStore.Save(icCardPasswordPath, SecretStore.ReadHidden());
                    Console.WriteLine("iCCard MDB 密码已使用 Windows DPAPI 加密保存。");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--install-parking-db-password")
                {
                    Console.Write("粘贴停车 SQL Server 密码（输入不会显示）：");
                    SecretStore.Save(parkingPasswordPath, SecretStore.ReadHidden());
                    Console.WriteLine("停车数据库密码已使用 Windows DPAPI 加密保存。");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--readers")
                {
                    var readers = CardReader.ListReaders();
                    Console.WriteLine(readers.Length == 0 ? "未检测到 PC/SC 读卡器" : String.Join(Environment.NewLine, readers));
                    return readers.Length == 0 ? 2 : 0;
                }
                var config = AgentConfig.Load(configPath);
                if (args.Length > 0 && args[0] == "--install-service")
                {
                    WindowsServiceInstaller.Install(config);
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--uninstall-service")
                {
                    WindowsServiceInstaller.Uninstall(config);
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--connect-test")
                {
                    var hasReader = config.Kind != "issuer" || CardReader.HasAcr122();
                    new AgentApiClient(config, SecretStore.Load(tokenPath)).Heartbeat(
                        AgentLoop.BuildCapabilities(config, hasReader));
                    AgentStatus.MarkConnected();
                    if (config.Kind == "parking_gateway")
                    {
                        var probes = ParkingDatabase.ProbeBoth(config, SecretStore.Load(parkingPasswordPath));
                        foreach (var probe in probes) PrintParkingProbe(probe);
                    }
                    Console.WriteLine("连接成功：PMS 已接受 " + config.Name + " 的心跳（版本 " + AgentApiClient.Version + "）。");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--access-probe")
                {
                    PrintProbe(AccessGatewayDatabase.ProbeMjSystem(config));
                    PrintProbe(AccessGatewayDatabase.ProbeIcCard(
                        config,
                        File.Exists(icCardPasswordPath) ? SecretStore.Load(icCardPasswordPath) : null));
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--parking-probe")
                {
                    var probes = ParkingDatabase.ProbeBoth(config, SecretStore.Load(parkingPasswordPath));
                    foreach (var probe in probes) PrintParkingProbe(probe);
                    return 0;
                }
                if (args.Length > 1 && args[0] == "--legacy-count")
                {
                    var result = LegacyDatabase.GetNextSequence(config, SecretStore.Load(databasePasswordPath), args[1]);
                    Console.WriteLine("已发数量：" + result.IssuedCount);
                    Console.WriteLine("下一序号：" + result.NextSequence);
                    return 0;
                }
                if (args.Length > 1 && args[0] == "--legacy-history")
                {
                    var result = LegacyDatabase.GetHistory(config, SecretStore.Load(databasePasswordPath), args[1]);
                    Console.WriteLine("已有人员尾号数：" + result.issuedCount);
                    Console.WriteLine("下一序号：" + result.nextSequence);
                    Console.WriteLine("序号\t捷顺编号\tIC 卡号\t发卡时间");
                    foreach (var item in result.history)
                    {
                        Console.WriteLine(
                            item.sequence + "\t" + item.personNo + "\t" +
                            (item.icCardNo ?? "-") + "\t" + (item.issuedAt ?? "-"));
                    }
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--console")
                {
                    var token = SecretStore.Load(tokenPath);
                    new AgentLoop(config, new AgentApiClient(config, token)).Run();
                    return 0;
                }
                Console.Error.WriteLine("未知参数。双击程序可打开设置界面。");
                return 2;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception.Message);
                return 1;
            }
        }

        private static void PrintProbe(AccessDatabaseProbeResult result)
        {
            Console.WriteLine("[" + result.Name + "] " + result.Path);
            Console.WriteLine("文件大小：" + result.Length + " bytes");
            foreach (var pair in result.Counts)
                Console.WriteLine(pair.Key + "：" + pair.Value);
        }

        private static void PrintParkingProbe(ParkingDatabaseProbeResult result)
        {
            Console.WriteLine("[" + result.Database + "] 只读连接成功");
            Console.WriteLine("Car_Issue 记录数：" + (result.VehicleCount < 0 ? "表不存在" : result.VehicleCount.ToString()));
            Console.WriteLine("Car_Download 记录数：" + (result.DownloadCount < 0 ? "表不存在" : result.DownloadCount.ToString()));
            foreach (var pair in result.Procedures)
                Console.WriteLine(pair.Key + "：" + (pair.Value ? "已找到" : "未找到"));
        }
    }
}
