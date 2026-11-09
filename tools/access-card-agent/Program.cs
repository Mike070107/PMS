using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.ServiceProcess;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Pms.AccessCardAgent
{
    internal static class Program
    {
        [STAThread]
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
                if (args.Length > 0 && args[0] == "--version")
                {
                    var assembly = typeof(Program).Assembly;
                    var fileInfo = FileVersionInfo.GetVersionInfo(assembly.Location);
                    Console.WriteLine("PMS 数据同步助手 " + AgentApiClient.Version);
                    Console.WriteLine("程序集版本：" + assembly.GetName().Version);
                    Console.WriteLine("文件版本：" + fileInfo.FileVersion);
                    Console.WriteLine("说明：本版本新增门禁库只读查询、能力如实上报和默认关闭的生命周期写；包内不含任何凭据。");
                    return 0;
                }
                if (args.Length > 2 && args[0] == "--apply-update")
                {
                    int previousProcessId;
                    if (!Int32.TryParse(args[2], out previousProcessId))
                        throw new InvalidOperationException("更新参数无效");
                    UpdateInstaller.Apply(args[1], previousProcessId);
                    return 0;
                }
                if (!Environment.UserInteractive)
                {
                    ServiceBase.Run(new AccessCardWindowsService(AgentConfig.Load(configPath), tokenPath));
                    return 0;
                }
                var executableName = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);
                if ((args.Length > 0 && args[0] == "--initializer") || executableName.IndexOf("初始化助手", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    using (var instance = SingleInstance.TryEnter("CardInitializer"))
                    {
                        if (instance == null) return 0;
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        Application.Run(new CardInitializerForm(root));
                    }
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
                if (args.Length == 0 || (args.Length > 0 && args[0] == "--updated"))
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
                        Application.Run(new AgentManagerForm(root, args.Length > 0 && args[0] == "--updated"));
                    }
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--self-test")
                {
                    int sequence;
                    if (!LegacyDatabase.TrySequence("228/5/301", "228/05/301/6", out sequence) || sequence != 6)
                        throw new InvalidOperationException("旧库房号序号解析测试失败");
                    if (!LegacyDatabase.TrySequence("228/2/102", "已隐藏228/02/102/5", out sequence) || sequence != 5)
                        throw new InvalidOperationException("旧库已隐藏房号解析测试失败");
                    if (!LegacyDatabase.TrySequence("228/02/102", "228/2/102/4", out sequence) || sequence != 4)
                        throw new InvalidOperationException("旧库楼号前导零兼容测试失败");
                    if (LegacyDatabase.TrySequence("228/5/301", "228/5/30/6", out sequence))
                        throw new InvalidOperationException("相似房号隔离测试失败");
                    if (LegacyDatabase.TrySequence("228/2/102", "已隐藏228/02/101/5", out sequence))
                        throw new InvalidOperationException("不同室号隔离测试失败");
                    if (AgentConfig.NormalizeAgentId("legacy_sync-legacy_sync-a8c6fe8239867d2e") != "legacy_sync-a8c6fe8239867d2e")
                        throw new InvalidOperationException("代理 ID 粘贴容错测试失败");
                    if (AgentConfig.NormalizeAgentId("parking_gateway-parking_gateway-a8c6fe8239867d2e") != "parking_gateway-a8c6fe8239867d2e")
                        throw new InvalidOperationException("停车网关代理 ID 粘贴容错测试失败");
                    string parsedAgentId;
                    string parsedToken;
                    if (!AgentConfig.TryParseConnectionKey("parking_gateway-a8c6fe8239867d2e.12345678901234567890", out parsedAgentId, out parsedToken) ||
                        parsedAgentId != "parking_gateway-a8c6fe8239867d2e" || parsedToken != "12345678901234567890")
                        throw new InvalidOperationException("一次性连接密钥解析测试失败");
                    var slashVariants = ParkingDatabase.SearchVariantsForTest("228/5/301");
                    if (!slashVariants.Contains("228/5/301") || !slashVariants.Contains("228-5-301"))
                        throw new InvalidOperationException("停车房号斜杠转横线测试失败");
                    var dashVariants = ParkingDatabase.SearchVariantsForTest("198-5-201");
                    if (!dashVariants.Contains("198-5-201") || !dashVariants.Contains("198/5/201"))
                        throw new InvalidOperationException("停车房号横线转斜杠测试失败");
                    if (ParkingDatabase.EscapeLikeForTest("A%_~[") != "A~%~_~~~[")
                        throw new InvalidOperationException("停车查询通配符转义测试失败");
                    var cardVariants = AccessDatabaseQuery.CardVariants("5516351");
                    if (Array.IndexOf(cardVariants, "5516351") < 0 || Array.IndexOf(cardVariants, "05516351") < 0)
                        throw new InvalidOperationException("门禁卡号补零查询变体测试失败");
                    var trimmedVariants = AccessDatabaseQuery.CardVariants("05516351");
                    if (Array.IndexOf(trimmedVariants, "5516351") < 0)
                        throw new InvalidOperationException("门禁卡号去零查询变体测试失败");
                    if (!AccessCardLifecycle.IsPmsRecord("PMS_ITEM_12") || AccessCardLifecycle.IsPmsRecord("228/5/301/3"))
                        throw new InvalidOperationException("PMS 发卡标记识别测试失败");
                    // 捷顺发卡历史字段契约：.80 上报的 JSON 字段名必须与 API LegacyHistoryEntryDto 一致
                    // （personCreatedAt=HR.Person.OptDate、lastSwipeAt=LastBrushCardTime、lastDevice=Device.Name、cardInfoId=CardInfo.ID）。
                    var legacyEntryJson = new JavaScriptSerializer().Serialize(new LegacyHistoryEntry
                    {
                        personId = 26412, personNo = "11296", sequence = 8, icCardNo = "B9F7D803",
                        issuedAt = "2026-11-09T14:58:19", personName = "228/50/202/8", cardInfoId = 12026,
                        personCreatedAt = "2015-03-20T22:52:06", lastSwipeAt = "2026-11-09T14:58:19", lastDevice = "3号岗入口"
                    });
                    foreach (var field in new[] { "cardInfoId", "personCreatedAt", "lastSwipeAt", "lastDevice" })
                    {
                        if (legacyEntryJson.IndexOf("\"" + field + "\"", StringComparison.Ordinal) < 0)
                            throw new InvalidOperationException("捷顺发卡历史上报字段名与后端 DTO 不一致：" + field);
                    }
                    var legacyEmptyJson = new JavaScriptSerializer().Serialize(new LegacyHistoryEntry
                    {
                        personId = 1, personNo = "1", sequence = 1
                    });
                    foreach (var field in new[] { "cardInfoId", "personCreatedAt", "lastSwipeAt", "lastDevice" })
                    {
                        if (legacyEmptyJson.IndexOf("\"" + field + "\":null", StringComparison.Ordinal) < 0)
                            throw new InvalidOperationException("捷顺发卡历史空字段未按 null 上报：" + field);
                    }
                    var legacyRoundTrip = new DateTime(2026, 11, 9, 14, 58, 19)
                        .ToString("o", CultureInfo.InvariantCulture);
                    if (legacyRoundTrip.Length > 40)
                        throw new InvalidOperationException("捷顺发卡历史时间字段超出后端 DTO 40 字符限制：" + legacyRoundTrip);
                    // iCCard WG 卡号去前导零规则（2026-11-07）：只在写 iCCard 时转换，其他系统保持原样。
                    var icNormalized = IcCardNumber.NormalizeForWrite("05108721");
                    if (icNormalized.value != "5108721" || String.IsNullOrWhiteSpace(icNormalized.warning))
                        throw new InvalidOperationException("iCCard WG 去前导零测试失败：05108721");
                    if (IcCardNumber.NormalizeForWrite("00108721").value != "108721")
                        throw new InvalidOperationException("iCCard WG 去前导零测试失败：00108721");
                    if (IcCardNumber.NormalizeForWrite("10000000").value != "10000000")
                        throw new InvalidOperationException("iCCard WG 去前导零误删中间零测试失败");
                    var allZero = IcCardNumber.NormalizeForWrite("00000000");
                    if (allZero.value != "0" || String.IsNullOrWhiteSpace(allZero.warning))
                        throw new InvalidOperationException("iCCard WG 全 0 边界测试失败");
                    if (IcCardNumber.ForSystem("mjsystem", "05108721") != "05108721" ||
                        IcCardNumber.ForSystem("legacy", "05108721") != "05108721")
                        throw new InvalidOperationException("MjSystem/捷顺不应受 iCCard 去零规则影响");
                    var icVariants = IcCardNumber.QueryVariants("00108721");
                    if (Array.IndexOf(icVariants, "108721") < 0 || Array.IndexOf(icVariants, "00108721") < 0 ||
                        Array.IndexOf(IcCardNumber.QueryVariants("00000000"), "") >= 0)
                        throw new InvalidOperationException("iCCard 读卡候选值测试失败");
                    var warningWritten = new[] { (object)new AccessDatabaseWriteResult { warning = "WG 卡号 00000000 去前导零后为空" } };
                    var warningUploads = new[] { (object)new AccessControllerUploadResult { buildingNo = "11", status = "controller_uploaded" } };
                    var mergedWarnings = AgentLoop.AttachIcCardWarnings(warningWritten, warningUploads);
                    if (AgentLoop.FirstWarning(mergedWarnings) == null ||
                        ((AccessControllerUploadResult)mergedWarnings[0]).warning == null)
                        throw new InvalidOperationException("iCCard 去零 warning 未传递到控制器回执/活动日志");
                    // 门禁主板远程控制：命令构造与不支持设备的明确拒绝（不连控制器）。
                    if (AccessControllerUploader.BuildIcCardDoorOperationFunction("remote_open", 1, 0) != "9D100101")
                        throw new InvalidOperationException("iCCard 立即开门命令测试失败");
                    if (AccessControllerUploader.BuildIcCardDoorOperationFunction("temporary_open", 26, 5) != "8F101A010032")
                        throw new InvalidOperationException("iCCard 临时常开命令测试失败");
                    if (AccessControllerUploader.BuildIcCardDoorOperationFunction("restore_normal", 26, 5) != "8F101A030032")
                        throw new InvalidOperationException("iCCard 恢复常开命令测试失败");
                    var mjRemoteArguments = AccessControllerUploader.BuildMjSystemRemoteOpenArguments("0160217", 1);
                    if (Convert.ToString(mjRemoteArguments[0], CultureInfo.InvariantCulture) != "1A" ||
                        Convert.ToString(mjRemoteArguments[1], CultureInfo.InvariantCulture) != "0160217" ||
                        Convert.ToString(mjRemoteArguments[2], CultureInfo.InvariantCulture) != "1")
                        throw new InvalidOperationException("MjSystem 立即开门参数测试失败");
                    AccessControllerUploader.ValidateMjSystemRemoteOpenCommand(
                        "9E01EB391A250100000000000000000000000000000000000000000000000000000002039D");
                    try
                    {
                        AccessControllerUploader.ValidateMjSystemRemoteOpenCommand(
                            "9E01EB390724000000000000000000000000000000000000000000000000000003039D");
                        throw new InvalidOperationException("MjSystem 非 1A 命令未被拒绝");
                    }
                    catch (InvalidOperationException exception)
                    {
                        if (exception.Message.IndexOf("不是 1A 远程开门命令", StringComparison.Ordinal) < 0) throw;
                    }
                    var unsupportedTask = new AgentTask
                    {
                        operation = "temporary_open",
                        targetBuildings = new[]
                        {
                            new AccessTargetBuilding { id = 26, buildingNo = "26", accessSystem = "mjsystem" }
                        }
                    };
                    var unsupportedResults = AccessControllerUploader.ExecuteDoorOperation(new AgentConfig(), null, unsupportedTask);
                    var unsupportedRejected = false;
                    foreach (var item in unsupportedResults)
                    {
                        var row = item as AccessControllerUploadResult;
                        if (row != null && row.status == "controller_failed" && row.error != null &&
                            row.error.IndexOf("未发送", StringComparison.Ordinal) >= 0) unsupportedRejected = true;
                    }
                    if (!unsupportedRejected || !AccessControllerUploader.HasDoorOperationFailures("temporary_open", unsupportedResults))
                        throw new InvalidOperationException("MjSystem 临时常开未按不支持设备明确拒绝");
                    using (var first = SingleInstance.TryEnter("SelfTest"))
                    using (var second = SingleInstance.TryEnter("SelfTest"))
                    {
                        if (first == null || second != null)
                            throw new InvalidOperationException("单实例锁测试失败");
                    }
                    Console.WriteLine("版本：" + AgentApiClient.Version);
                    Console.WriteLine("自检通过：门禁房号隔离、门禁开门/常开命令构造、iCCard 卡号去零、停车房号格式和查询通配符转义正常");
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
                    string connectionAgentId;
                    string connectionToken;
                    if (AgentConfig.TryParseConnectionKey(credential, out connectionAgentId, out connectionToken))
                    {
                        AgentConfig.InstallAgentId(configPath, connectionAgentId);
                        SecretStore.Save(tokenPath, connectionToken);
                    }
                    else
                    {
                        AgentConfig.InstallAgentId(configPath, args[1]);
                        SecretStore.Save(tokenPath, credential);
                    }
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
                if (args.Length == 4 && args[0] == "--install-card-profiles")
                {
                    CardProfiles.Install(Path.Combine(root, CardProfiles.ProtectedFileName), args[1], args[2], args[3]);
                    Console.WriteLine("卡片模板已用 Windows DPAPI 加密保存，明文密钥未写入日志。");
                    return 0;
                }
                if (args.Length == 5 && args[0] == "--build-portable-profile-seed")
                {
                    CardProfiles.BuildPortableSeed(args[1], args[2], args[3], args[4]);
                    Console.WriteLine("便携版卡片模板已生成：" + args[1]);
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--inspect-card")
                {
                    PrintCardInspection(CardReader.Inspect(CardProfiles.Load(Path.Combine(root, CardProfiles.ProtectedFileName))));
                    return 0;
                }
                if (args.Length > 1 && args[0] == "--access-driver-test")
                {
                    Console.WriteLine("Bitness: " + (IntPtr.Size == 4 ? "x86" : "x64"));
                    Console.WriteLine("BaseDirectory: " + AppDomain.CurrentDomain.BaseDirectory);
                    Console.WriteLine("CurrentDirectory: " + Environment.CurrentDirectory);
                    using (var connection = AccessOleDb.Open(args[1], null, "test"))
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT COUNT(*) FROM Employee";
                        Console.WriteLine("Employee: " + command.ExecuteScalar());
                    }
                    return 0;
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
                    var parkingWrite = config.Kind == "parking_gateway" &&
                        ParkingDatabase.CanWriteBoth(config, SecretStore.Load(parkingPasswordPath));
                    new AgentApiClient(config, SecretStore.Load(tokenPath)).Heartbeat(
                        AgentLoop.BuildCapabilities(config, hasReader, parkingWrite));
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
                if (args.Length > 0 && args[0] == "--parking-procedure-info")
                {
                    var password = SecretStore.Load(parkingPasswordPath);
                    foreach (var database in new[] { config.ParkingPhase1Database, config.ParkingPhase2Database })
                    {
                        Console.WriteLine("[" + database + "]");
                        foreach (var item in ParkingDatabase.DescribeProcedures(config, password, database))
                            Console.WriteLine(item.Key + ": " + item.Value);
                    }
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
                if (args.Length > 1 && args[0] == "--legacy-card-check")
                {
                    var matches = LegacyDatabase.FindCard(config, SecretStore.Load(databasePasswordPath), args[1]);
                    if (matches.Count == 0)
                    {
                        Console.WriteLine("未在捷顺系统查到该 IC 卡号。");
                        return 0;
                    }
                    Console.WriteLine("该卡已在捷顺系统发过，共 " + matches.Count + " 条记录：");
                    Console.WriteLine("原用户\t捷顺系统编号\tIC 卡号\t发卡时间");
                    foreach (var match in matches)
                        Console.WriteLine(match.personName + "\t" + match.personNo + "\t" + match.icCardNo + "\t" + (match.issuedAt ?? "-"));
                    return 3;
                }
                if (args.Length > 0 && args[0] == "--access-query")
                {
                    if (args.Length < 2) throw new InvalidOperationException("用法：--access-query <卡号|房号|姓名>");
                    var query = AccessDatabaseQuery.Query(config, OptionalSecret(icCardPasswordPath), args[1]);
                    PrintJson(query);
                    return query.errors.Count > 0 && query.cards.Count == 0 ? 3 : 0;
                }
                if (args.Length > 1 && args[0] == "--access-records")
                {
                    var records = AccessDatabaseQuery.RecentRecords(config, OptionalSecret(icCardPasswordPath), args[1]);
                    PrintJson(records);
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--access-groups")
                {
                    PrintJson(AccessDatabaseQuery.Groups(config, OptionalSecret(icCardPasswordPath)));
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--access-capabilities")
                {
                    PrintJson(AccessDatabaseCapabilityProbe.Probe(config, OptionalSecret(icCardPasswordPath)));
                    return 0;
                }
                if (args.Length > 2 && args[0] == "--access-lifecycle")
                {
                    var request = new AccessLifecycleRequest
                    {
                        operation = args[1],
                        wgCardNo = args[2],
                        requestKey = DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture),
                        reason = "PMS CLI"
                    };
                    var doorIds = new List<int>();
                    for (var index = 3; index < args.Length; index += 1)
                    {
                        var value = args[index];
                        if ((value == "--date" || value == "--end") && index + 1 < args.Length)
                        {
                            request.endDate = DateTime.ParseExact(args[index + 1], "yyyy-MM-dd", CultureInfo.InvariantCulture);
                            index += 1;
                        }
                        else if (value == "--doors" && index + 1 < args.Length)
                        {
                            foreach (var part in args[index + 1].Split(','))
                            {
                                int door;
                                if (Int32.TryParse(part.Trim(), out door)) doorIds.Add(door);
                            }
                            index += 1;
                        }
                        else if (value == "--allow-non-pms")
                        {
                            request.allowNonPms = true;
                        }
                    }
                    request.restoreDoorIds = doorIds.ToArray();
                    var lifecycle = AccessCardLifecycle.Execute(config, OptionalSecret(icCardPasswordPath), request);
                    PrintJson(lifecycle);
                    return lifecycle.rows.Exists(row => row.status == "failed") ? 4 : 0;
                }
                if (args.Length > 1 && args[0] == "--legacy-search")
                {
                    PrintJson(LegacyDatabase.SearchCards(config, SecretStore.Load(databasePasswordPath), args[1]));
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--legacy-schema")
                {
                    if (args.Length > 1)
                    {
                        PrintJson(LegacyDatabase.SchemaColumns(config, SecretStore.Load(databasePasswordPath), args[1]));
                    }
                    else
                    {
                        PrintJson(LegacyDatabase.SchemaTables(config, SecretStore.Load(databasePasswordPath)));
                    }
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--legacy-capabilities")
                {
                    PrintJson(LegacyDatabase.Probe(config, SecretStore.Load(databasePasswordPath)));
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
                if (args.Length > 0 && args[0] == "--apply-update")
                    MessageBox.Show("更新失败：" + exception.Message, "PMS 数据同步助手", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Console.Error.WriteLine(exception.Message);
                return 1;
            }
        }

        private static void PrintCardInspection(CardInspection result)
        {
            Console.WriteLine("卡片 UID：" + result.Uid);
            Console.WriteLine("识别结果：" + result.Message);
            if (result.IcNo.HasValue) Console.WriteLine("ICNO：" + result.IcNo.Value);
        }

        private static void PrintProbe(AccessDatabaseProbeResult result)
        {
            Console.WriteLine("[" + result.Name + "] " + result.Path);
            Console.WriteLine("文件大小：" + result.Length + " bytes");
            foreach (var pair in result.Counts)
                Console.WriteLine(pair.Key + "：" + pair.Value);
        }

        private static string OptionalSecret(string path)
        {
            return File.Exists(path) ? SecretStore.Load(path) : null;
        }

        private static void PrintJson(object value)
        {
            Console.WriteLine(new JavaScriptSerializer().Serialize(value));
        }

        private static void PrintParkingProbe(ParkingDatabaseProbeResult result)
        {
            Console.WriteLine("[" + result.Database + "] 数据库连接成功");
            Console.WriteLine("Car_Issue 记录数：" + (result.VehicleCount < 0 ? "表不存在" : result.VehicleCount.ToString()));
            Console.WriteLine("Car_Download 记录数：" + (result.DownloadCount < 0 ? "表不存在" : result.DownloadCount.ToString()));
            foreach (var pair in result.Procedures)
                Console.WriteLine(pair.Key + "：" + (pair.Value ? "已找到" : "未找到"));
        }
    }
}
