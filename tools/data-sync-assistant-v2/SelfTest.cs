using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Pms.AccessCardAgent;

namespace Pms.DataSyncAssistant
{
    internal static class SelfTest
    {
        public static void Run()
        {
            var root = Path.Combine(Path.GetTempPath(), "PmsDataSyncAssistantV2Test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                var store = new ConfigurationStore(root);
                var config = store.Load();
                if (config.SchemaVersion != 2 || String.IsNullOrWhiteSpace(config.Host.HostId))
                    throw new InvalidOperationException("主机配置初始化失败");

                var connection = new ConnectionConfiguration
                {
                    Type = ConnectionTypes.Parking,
                    Name = "测试停车连接",
                    HostName = config.Host.Name,
                    HostIp = config.Host.IpAddress,
                    DataLocation = "SQL Server 127.0.0.1"
                };
                connection.Parameters["server"] = "127.0.0.1";
                config.Connections.Add(connection);
                store.Save(config);
                store.SetSecret("connection:" + connection.Id + ":password", "test-password");

                var reloaded = store.Load();
                if (reloaded.Connections.Count != 1 || reloaded.Connections[0].Name != "测试停车连接")
                    throw new InvalidOperationException("多连接配置保存失败");
                if (store.GetSecret("connection:" + connection.Id + ":password") != "test-password")
                    throw new InvalidOperationException("DPAPI 加密存储失败");
                if (!File.Exists(Path.Combine(root, "connections.json.previous")))
                    throw new InvalidOperationException("配置备份未生成");

                VerifyRuntimeMapping(store, config);
                VerifyAccessGatewayMigration(root);
                VerifyLegacyRoomMatching();
                VerifyParkingOwnerColumnMapping();
                VerifyActivityHistory(root);
                VerifyAssistantUpdater(root);
                VerifyProductUpdater();
                VerifySafeUpgradeRecovery();
            }
            finally
            {
                var full = Path.GetFullPath(root);
                var temp = Path.GetFullPath(Path.GetTempPath());
                if (full.StartsWith(temp, StringComparison.OrdinalIgnoreCase) && Directory.Exists(full))
                    Directory.Delete(full, true);
            }
        }

        public static void RunWizardSmokeTest()
        {
            var root = Path.Combine(Path.GetTempPath(), "PmsDataSyncAssistantWizardTest-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                var store = new ConfigurationStore(root);
                var host = new HostConfiguration();
                foreach (var type in new[] { ConnectionTypes.Parking, ConnectionTypes.LegacyAccess, ConnectionTypes.BuildingAccess, ConnectionTypes.CardReader })
                {
                    var item = new ConnectionConfiguration { Type = type, Name = ConnectionTypes.Label(type), HostName = host.Name, HostIp = host.IpAddress };
                    var window = new ConnectionWizard(host, store, item) { ShowInTaskbar = false, Opacity = 0 };
                    window.Loaded += delegate { window.Close(); };
                    window.ShowDialog();
                }
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        public static void RenderMainWindow(string outputPath)
        {
            var root = Path.Combine(Path.GetTempPath(), "PmsDataSyncAssistantRender-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try
            {
                var window = new MainWindow(new ConfigurationStore(root))
                {
                    ShowInTaskbar = false,
                    WindowStartupLocation = System.Windows.WindowStartupLocation.Manual,
                    Left = -12000,
                    Top = -12000
                };
                window.Show();
                window.UpdateLayout();
                var width = Math.Max(1, (int)Math.Ceiling(window.ActualWidth));
                var height = Math.Max(1, (int)Math.Ceiling(window.ActualHeight));
                var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
                bitmap.Render(window);
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using (var stream = File.Create(outputPath)) encoder.Save(stream);
                window.Close();
            }
            finally
            {
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        }

        private static void VerifyRuntimeMapping(ConfigurationStore store, AssistantConfiguration config)
        {
            if (ConnectionAgentRuntime.RuntimeVersion != typeof(SelfTest).Assembly.GetName().Version.ToString(3))
                throw new InvalidOperationException("心跳版本必须与当前助手程序集版本一致");
            var access = new ConnectionConfiguration { Type = ConnectionTypes.BuildingAccess, Name = "门禁测试" };
            access.Parameters["agentId"] = "access_gateway-0123456789abcdef";
            access.Parameters["mjSystemPath"] = @"D:\data\MJDataBase.mdb";
            access.Parameters["icCardPath"] = @"D:\data\iCCard.mdb";
            config.Host.BaseUrl = "https://example.invalid/api/v1/";
            var mapped = ConnectionAgentRuntime.BuildAgentConfig(access, config.Host);
            if (mapped.Kind != "access_gateway" || mapped.BaseUrl != "https://example.invalid/api/v1" ||
                mapped.MjSystemDatabasePath != @"D:\data\MJDataBase.mdb" || mapped.IcCardDatabasePath != @"D:\data\iCCard.mdb")
                throw new InvalidOperationException("楼栋门禁运行参数映射失败");

            string error;
            if (ConnectionAgentRuntime.CanStart(access, store, out error) || error.IndexOf("连接密钥") < 0)
                throw new InvalidOperationException("缺少代理密钥时未被阻止");
            store.SetSecret(ConnectionAgentRuntime.TokenKey(access), "test-agent-token-1234567890");
            if (!ConnectionAgentRuntime.CanStart(access, store, out error))
                throw new InvalidOperationException("完整代理配置未通过运行校验：" + error);

            var capabilities = AgentLoop.BuildCapabilities(mapped, true, false, true, false);
            if (!capabilities["accessDbWrite"] || capabilities["controllerUpload"])
                throw new InvalidOperationException("门禁数据库与控制器能力没有独立上报");
            capabilities = AgentLoop.BuildCapabilities(mapped, true, false, true, true);
            if (!capabilities["controllerUpload"] || !capabilities["historicalAccessGrant"])
                throw new InvalidOperationException("控制器通信组件就绪后未上报下发能力");

            var json = "{\"action\":\"activate_access\",\"itemId\":8,\"wgCardNo\":\"22355403\",\"targetBuildings\":[{\"id\":11,\"buildingNo\":\"11\",\"accessSystem\":\"iccard\"}]}";
            var task = new JavaScriptSerializer().Deserialize<AgentTask>(json);
            if (task.targetBuildings == null || task.targetBuildings.Length != 1 ||
                task.targetBuildings[0].buildingNo != "11" || task.targetBuildings[0].accessSystem != "iccard")
                throw new InvalidOperationException("门禁任务楼栋快照解析失败");

            var grantJson = "{\"action\":\"authorize_existing_card\",\"taskId\":19,\"wgCardNo\":\"22355403\",\"targetBuildings\":[{\"id\":11,\"buildingNo\":\"11\",\"accessSystem\":\"iccard\"}]}";
            var grant = new JavaScriptSerializer().Deserialize<AgentTask>(grantJson);
            if (grant.taskId != 19 || grant.action != "authorize_existing_card" || grant.targetBuildings.Length != 1)
                throw new InvalidOperationException("历史卡追加楼栋权限任务解析失败");
        }

        private static void VerifyAccessGatewayMigration(string root)
        {
            var legacyRoot = Path.Combine(root, "legacy-access");
            var targetRoot = Path.Combine(root, "migrated");
            Directory.CreateDirectory(legacyRoot);
            File.WriteAllText(Path.Combine(legacyRoot, "agent.config.json"),
                "{\"BaseUrl\":\"https://prsznh.cn/api/v1\",\"AgentId\":\"access_gateway-0123456789abcdef\",\"Kind\":\"access_gateway\",\"Name\":\"192.168.1.88 门禁网关\",\"MjSystemDatabasePath\":\"D:\\\\MDB\\\\MJDataBase.mdb\",\"IcCardDatabasePath\":\"D:\\\\MDB\\\\iCCard.mdb\"}", Encoding.UTF8);
            WriteLegacySecret(Path.Combine(legacyRoot, "agent.token.dat"), "agent-secret-value");
            WriteLegacySecret(Path.Combine(legacyRoot, "iccard-db-password.dat"), "iccard-password-value");

            var store = new ConfigurationStore(targetRoot);
            var target = store.Load();
            var result = new LegacyMigrationResult();
            new LegacyConfigurationMigrator(store).ImportDirectory(legacyRoot, target, result);
            if (result.Imported != 1 || target.Connections.Count != 1)
                throw new InvalidOperationException("旧版 .88 配置迁移失败");
            var imported = target.Connections[0];
            if (imported.Parameters["mjSystemPath"] != @"D:\MDB\MJDataBase.mdb" ||
                imported.Parameters["icCardPath"] != @"D:\MDB\iCCard.mdb")
                throw new InvalidOperationException("旧版 MDB 路径迁移失败");
            if (store.GetSecret(ConnectionAgentRuntime.TokenKey(imported)) != "agent-secret-value" ||
                store.GetSecret(ConnectionAgentRuntime.PasswordKey(imported)) != "iccard-password-value")
                throw new InvalidOperationException("旧版 .88 密钥迁移失败");

            imported.Parameters["mjSystemPath"] = "";
            imported.Parameters["icCardPath"] = "";
            store.SetSecret(ConnectionAgentRuntime.TokenKey(imported), "");
            store.SetSecret(ConnectionAgentRuntime.PasswordKey(imported), "");
            var repair = new LegacyMigrationResult();
            new LegacyConfigurationMigrator(store).ImportDirectory(legacyRoot, target, repair);
            if (repair.Updated != 1 || imported.Parameters["mjSystemPath"] != @"D:\MDB\MJDataBase.mdb" ||
                store.GetSecret(ConnectionAgentRuntime.PasswordKey(imported)) != "iccard-password-value")
                throw new InvalidOperationException("预览版残缺配置未能自动修复");
        }

        private static void WriteLegacySecret(string path, string value)
        {
            var entropy = Encoding.UTF8.GetBytes("PMS.AccessCardAgent.v1");
            File.WriteAllBytes(path, ProtectedData.Protect(Encoding.UTF8.GetBytes(value), entropy, DataProtectionScope.LocalMachine));
        }

        private static void VerifyLegacyRoomMatching()
        {
            int sequence;
            if (!LegacyDatabase.TrySequence("228/2/102", "已隐藏228/02/102/5", out sequence) || sequence != 5)
                throw new InvalidOperationException("已隐藏的旧库房号未被识别");
            if (!LegacyDatabase.TrySequence("228/02/102", "228/2/102/4", out sequence) || sequence != 4)
                throw new InvalidOperationException("旧库楼号前导零兼容失败");
            if (LegacyDatabase.TrySequence("228/2/102", "已隐藏228/02/101/5", out sequence))
                throw new InvalidOperationException("旧库模糊查询把不同室号合并了");
        }

        private static void VerifyParkingOwnerColumnMapping()
        {
            var columns = new[] { "UserID", "owner_Name", "owner_Tel", "owner_Add" };
            if (ParkingDatabase.ResolveOwnerColumnForTest("name", "owner_Name", columns) != null)
                throw new InvalidOperationException("停车旧库把房号 owner_Name 误识别成了姓名");
            if (ParkingDatabase.ResolveOwnerColumnForTest("phone", "owner_Tel", columns) != "owner_Tel")
                throw new InvalidOperationException("停车住户电话栏位映射失败");
            if (ParkingDatabase.ResolveOwnerColumnForTest("room", "owner_Name", columns) != "owner_Name")
                throw new InvalidOperationException("停车住户房号未映射到 owner_Name");
            if (ParkingDatabase.ResolveOwnerColumnForTest("note", "P_note", "P_ID", "P_note") != "P_note")
                throw new InvalidOperationException("停车住户备注栏位映射失败");
            if (ParkingDatabase.ResolveOwnerColumnForTest("phone", "P_note", columns) != "owner_Tel")
                throw new InvalidOperationException("停车住户栏位提示越权覆盖了语义匹配");
            if (ParkingDatabase.SearchKindForTest("6/502") != "House")
                throw new InvalidOperationException("停车房号查询类型识别失败");
            var housePatterns = ParkingDatabase.SearchPatternsForTest("6/502");
            if (!housePatterns.Contains("%/6/502") || !housePatterns.Contains("%/6/502/%") ||
                !housePatterns.Contains("6/502") || !housePatterns.Contains("6/502/%") ||
                housePatterns.Contains("%/6/502%") || housePatterns.Any(delegate(string value) { return value.Contains("36/502"); }))
                throw new InvalidOperationException("停车房号查询边界错误");
            var fullHousePatterns = ParkingDatabase.SearchPatternsForTest("198/12/101");
            if (!fullHousePatterns.Contains("12/101") || !fullHousePatterns.Contains("%198/12/101") ||
                !ParkingDatabase.SearchAppliesToDatabaseForTest("198/12/101", "parking1", "parking1", "parking2") ||
                ParkingDatabase.SearchAppliesToDatabaseForTest("198/12/101", "parking2", "parking1", "parking2") ||
                !ParkingDatabase.SearchAppliesToDatabaseForTest("12/101", "parking1", "parking1", "parking2") ||
                !ParkingDatabase.SearchAppliesToDatabaseForTest("12/101", "parking2", "parking1", "parking2"))
                throw new InvalidOperationException("停车裸房号与所属数据库映射失败");
            if (ParkingDatabase.SearchKindForTest("DQ8839") != "PlateTail")
                throw new InvalidOperationException("停车车牌尾号识别失败");
            if (ParkingDatabase.SearchKindForTest("8839") != "PlateTail")
                throw new InvalidOperationException("停车纯数字车牌尾号识别失败");
            try
            {
                ParkingDatabase.SearchKindForTest("502");
                throw new InvalidOperationException("停车短数字查询未被拦截");
            }
            catch (InvalidOperationException exception)
            {
                if (!exception.Message.Contains("数字信息太少")) throw;
            }
            try
            {
                ParkingDatabase.SearchKindForTest("28/49/1202");
                throw new InvalidOperationException("歧义三段地址被误识别成裸房号");
            }
            catch (InvalidOperationException exception)
            {
                if (!exception.Message.Contains("无法识别查询内容")) throw;
            }
            var marked = ParkingDatabase.AppendPmsSourceForTest("原备注");
            if (marked != "原备注" + Environment.NewLine + "操作来源：PMS系统" ||
                ParkingDatabase.AppendPmsSourceForTest(marked) != marked)
                throw new InvalidOperationException("停车住户备注来源标识未保持幂等");

            var duplicateRows = new List<ParkingSearchRow>
            {
                new ParkingSearchRow { database = "parking2", fields = new Dictionary<string, object> { { "P_ID", 41 }, { "P_plate", "鄂QQ3632" }, { "Owner_ID", 414 } } },
                new ParkingSearchRow { database = "parking2", fields = new Dictionary<string, object> { { "P_ID", 41 }, { "Owner__owner_Tel", "13402178801" }, { "Owner__owner_Add", "228-31-702" } } },
            };
            var deduplicated = ParkingDatabase.DeduplicateRowsForTest(duplicateRows);
            if (deduplicated.Count != 1 || !deduplicated[0].fields.ContainsKey("Owner__owner_Tel"))
                throw new InvalidOperationException("停车重复车牌记录未正确合并");

            var json = "{\"taskId\":9,\"database\":\"parking2\",\"externalOwnerId\":\"668\",\"plate\":\"苏K163SM\",\"expected\":{\"name\":null,\"phone\":\"13800000000\",\"room\":\"228/2/102\",\"note\":\"地库91号\"},\"values\":{\"name\":null,\"phone\":\"13900000000\",\"room\":\"228/2/102\",\"note\":\"地库91号\"},\"fieldHints\":{\"phone\":\"P_Tel\",\"room\":\"P_Room\",\"note\":\"P_note\"}}";
            var task = new JavaScriptSerializer().Deserialize<ParkingOwnerUpdateTask>(json);
            if (task == null || task.taskId != 9 || task.database != "parking2" || task.fieldHints.phone != "P_Tel" || task.plate != "苏K163SM")
                throw new InvalidOperationException("停车住户更新任务解析失败");
            var contractPath = Environment.GetEnvironmentVariable("PMS_PARKING_OWNER_CONTRACT");
            if (!String.IsNullOrWhiteSpace(contractPath))
            {
                var apiTask = new JavaScriptSerializer().Deserialize<ParkingOwnerUpdateTask>(File.ReadAllText(contractPath));
                if (apiTask.plate != "苏K163SM" || apiTask.database != "parking2" || apiTask.externalOwnerId != "1851" ||
                    apiTask.values.room != "228/53/301" || apiTask.values.phone != "02112345678" || apiTask.expected.note != null)
                    throw new InvalidOperationException("API 实际领取报文与 Windows 写库协议不一致");
            }

            var notes = new System.Data.DataTable();
            notes.Columns.Add("P_note", typeof(string));
            notes.Rows.Add(DBNull.Value);
            using (var reader = notes.CreateDataReader())
                if (ParkingDatabase.ReadUniqueIssueNote(reader, task.plate) != null)
                    throw new InvalidOperationException("空备注应保留为 null，不能误判车牌不存在");
            notes.Rows[0][0] = " 第一行\r\n 第二行 ";
            using (var reader = notes.CreateDataReader())
                if (ParkingDatabase.ReadUniqueIssueNote(reader, task.plate) != " 第一行\r\n 第二行 ")
                    throw new InvalidOperationException("并发比对必须保留数据库原始空格与换行");
            notes.Rows.Add("重复记录");
            try
            {
                using (var reader = notes.CreateDataReader()) ParkingDatabase.ReadUniqueIssueNote(reader, task.plate);
                throw new InvalidOperationException("重复车牌未被拦截");
            }
            catch (InvalidOperationException exception) { if (!exception.Message.Contains("存在重复记录")) throw; }
            notes.Rows.Clear();
            try
            {
                using (var reader = notes.CreateDataReader()) ParkingDatabase.ReadUniqueIssueNote(reader, task.plate);
                throw new InvalidOperationException("不存在的车牌未被拦截");
            }
            catch (InvalidOperationException exception) { if (!exception.Message.Contains("找不到")) throw; }
        }

        private static void VerifyActivityHistory(string root)
        {
            var activityRoot = Path.Combine(root, "activities");
            ActivityStore.Record(activityRoot, "legacy-1", "枫桦一二期小区大门门禁系统接入", new AgentActivity
            {
                OccurredAt = DateTimeOffset.Now.AddSeconds(-1),
                Operation = "查询门禁卡",
                Target = "228/2/102",
                Success = true,
                Message = "查到 5 张历史卡"
            });
            ActivityStore.Record(activityRoot, "legacy-1", "枫桦一二期小区大门门禁系统接入", new AgentActivity
            {
                OccurredAt = DateTimeOffset.Now,
                Operation = "查询门禁卡",
                Target = "228/2/103",
                Success = false,
                Message = "数据库连接失败"
            });
            var activities = ActivityStore.Load(activityRoot);
            if (activities.Count != 2 || activities[0].Target != "228/2/103" || activities[0].Success ||
                activities[1].Target != "228/2/102" || !activities[1].Success)
                throw new InvalidOperationException("最近活动没有按时间保存查询成功和失败状态");
        }

        private static void VerifyAssistantUpdater(string root)
        {
            var target = Path.Combine(root, "installed", "Pms.DataSyncAssistant.V2.exe");
            var sameTargetWithDifferentCase = target.ToUpperInvariant();
            var otherDirectory = Path.Combine(root, "other", "Pms.DataSyncAssistant.V2.exe");
            if (!AssistantUpdateService.IsSameExecutablePath(sameTargetWithDifferentCase, target) ||
                AssistantUpdateService.IsSameExecutablePath(otherDirectory, target))
                throw new InvalidOperationException("助手更新器没有按完整路径限定待退出进程");

            Directory.CreateDirectory(Path.GetDirectoryName(target));
            Directory.CreateDirectory(Path.GetDirectoryName(otherDirectory));
            var currentExecutable = Process.GetCurrentProcess().MainModule.FileName;
            if (!String.IsNullOrWhiteSpace(currentExecutable) && File.Exists(currentExecutable))
            {
                File.Copy(currentExecutable, target, true);
                File.Copy(currentExecutable, otherDirectory, true);
                Process targetProcess = null;
                Process otherProcess = null;
                try
                {
                    const string waitArguments = "--update-lock-test-worker";
                    targetProcess = Process.Start(new ProcessStartInfo { FileName = target, Arguments = waitArguments, UseShellExecute = false, CreateNoWindow = true });
                    otherProcess = Process.Start(new ProcessStartInfo { FileName = otherDirectory, Arguments = waitArguments, UseShellExecute = false, CreateNoWindow = true });
                    System.Threading.Thread.Sleep(250);
                    AssistantUpdateService.StopProcessesUsingTargetExecutable(target);
                    if (!targetProcess.WaitForExit(2000))
                        throw new InvalidOperationException("助手更新器未能退出占用目标文件的托盘进程");
                    if (otherProcess.HasExited)
                        throw new InvalidOperationException("助手更新器误退出了其他目录中的助手进程");
                    File.Copy(currentExecutable, target, true);
                }
                finally
                {
                    if (targetProcess != null)
                    {
                        try { if (!targetProcess.HasExited) targetProcess.Kill(); } catch { }
                        targetProcess.Dispose();
                    }
                    if (otherProcess != null)
                    {
                        try { if (!otherProcess.HasExited) otherProcess.Kill(); } catch { }
                        otherProcess.Dispose();
                    }
                }
            }

            var updates = Path.Combine(root, "updates");
            Directory.CreateDirectory(updates);
            File.WriteAllText(Path.Combine(updates, "latest.json"),
                "{\"version\":\"2.5.1\",\"url\":\"https://prsznh.cn/downloads/pms-data-sync-assistant/2.5.1/Pms.DataSyncAssistant.V2.exe\",\"releaseNotes\":\"本地清单测试\"}", Encoding.UTF8);
            var result = AssistantUpdateService.CheckAndDownload("2.5.1", root);
            if (result.HasUpdate || result.CurrentVersion != "2.5.1")
                throw new InvalidOperationException("助手更新清单版本比较失败");
            if (result.Manifest == null || result.Manifest.DownloadUrl != "https://prsznh.cn/downloads/pms-data-sync-assistant/2.5.1/Pms.DataSyncAssistant.V2.exe")
                throw new InvalidOperationException("新版 url 字段未兼容为下载地址");
        }

        private static void VerifyProductUpdater()
        {
            if (!UpdateManager.IsTrustedDownloadUrl("https://prsznh.cn/downloads/pms-data-sync-assistant/2.3.0/Pms.DataSyncAssistant.V2.exe"))
                throw new InvalidOperationException("合法的更新地址被拒绝");
            if (UpdateManager.IsTrustedDownloadUrl("http://prsznh.cn/downloads/pms-data-sync-assistant/latest.json") ||
                UpdateManager.IsTrustedDownloadUrl("https://example.com/downloads/pms-data-sync-assistant/latest.json") ||
                UpdateManager.IsTrustedDownloadUrl("https://prsznh.cn.evil.example/downloads/pms-data-sync-assistant/latest.json"))
                throw new InvalidOperationException("非 HTTPS 或非 PMS 主机的更新地址未被拦截");
            if (!UpdateManager.IsVersionAtLeast("2.3.0", "2.2.9") || UpdateManager.IsVersionAtLeast("2.2.9", "2.3.0") ||
                UpdateManager.IsVersionAtLeast("不是版本", "2.3.0"))
                throw new InvalidOperationException("已安装版本判定失效");
            Version current;
            Version newer;
            if (!Version.TryParse(UpdateManager.CurrentVersion, out current) || !Version.TryParse("99.0.0", out newer) ||
                newer.CompareTo(current) <= 0)
                throw new InvalidOperationException("版本比较逻辑失效");
        }

        private static void VerifySafeUpgradeRecovery()
        {
            if (UnifiedServiceManager.ChooseFailureAction(true, 0) != UpgradeFailureAction.KeepUnifiedRunning ||
                UnifiedServiceManager.ChooseFailureAction(true, 2) != UpgradeFailureAction.KeepUnifiedRunning)
                throw new InvalidOperationException("健康状态延迟会误停正在运行的新版服务");
            if (UnifiedServiceManager.ChooseFailureAction(false, 2) != UpgradeFailureAction.RestoreVerifiedLegacy)
                throw new InvalidOperationException("新版启动失败时未选择已存在的旧版回退路径");
            if (UnifiedServiceManager.ChooseFailureAction(false, 0) != UpgradeFailureAction.RetryUnifiedWithoutFallback)
                throw new InvalidOperationException("没有旧服务时仍可能卸载唯一的新版服务");
        }
    }
}
