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
                VerifyParkingMovementSource();
                VerifyParkingFeeSource();
                VerifyParkingDownloadParameters();
                VerifyParkingOwnerRebind();
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

        private static void VerifyParkingMovementSource()
        {
            using (var connection = new System.Data.SqlClient.SqlConnection())
            using (var command = ParkingDatabase.CreateMovementCommand(connection, "沪ATEST1", new DateTime(2026, 10, 1), new DateTime(2026, 10, 2), true, true))
            {
                if (!command.CommandText.Contains("[dbo].[Car_Out]") ||
                    !command.CommandText.Contains("[P_plate] = @plate") ||
                    !command.CommandText.Contains("[Int_Time]") ||
                    !command.CommandText.Contains("[out_Time]") ||
                    command.CommandText.Contains("View_RecordAll") ||
                    (string)command.Parameters["@plate"].Value != "沪ATEST1")
                    throw new InvalidOperationException("停车进出记录没有使用停车库 Car_Out 的精确车牌和日期范围");
            }
            var table = new System.Data.DataTable();
            table.Columns.Add("P_plate", typeof(string));
            table.Columns.Add("Int_Time", typeof(DateTime));
            table.Columns.Add("out_Time", typeof(DateTime));
            table.Columns.Add("P_InPakname", typeof(string));
            table.Columns.Add("P_OutPakname", typeof(string));
            table.Rows.Add("沪ATEST1", new DateTime(2026, 10, 1, 8, 1, 2), new DateTime(2026, 10, 1, 18, 3, 4), "一期入口", "一期出口");
            using (var reader = table.CreateDataReader())
            {
                var rows = ParkingDatabase.ReadMovementRows(reader, "parking1");
                if (rows.Count != 1 || (string)rows[0].fields["carNo"] != "沪ATEST1" ||
                    (string)rows[0].fields["inTime"] != "2026-10-01 08:01:02" ||
                    (string)rows[0].fields["outTime"] != "2026-10-01 18:03:04" ||
                    (string)rows[0].fields["inGate"] != "一期入口" ||
                    (string)rows[0].fields["outGate"] != "一期出口")
                    throw new InvalidOperationException("停车 Car_Out 字段映射错误");
            }
        }

        private static void VerifyParkingFeeSource()
        {
            if (ParkingDatabase.ParkingExitFeeTable != "[dbo].[Car_Out]" ||
                ParkingDatabase.ParkingExitFeeDate != "[out_Time]" ||
                ParkingDatabase.ParkingExitFeeAmount != "[P_Shoufei]")
                throw new InvalidOperationException("停车出场收费报表未使用停车库 Car_Out 的收费字段");
        }

        private static void VerifyParkingOwnerRebind()
        {
            if (ParkingDatabase.CanonicalBindingRoom("198-08-0102") != "198/8/102") throw new InvalidOperationException("绑定房号规范化失败");
            if (ParkingDatabase.NextBindingRoom("198/8/102", new string[0]) != "198/8/102") throw new InvalidOperationException("空房号分配失败");
            if (ParkingDatabase.NextBindingRoom("198/8/102", new[] { "198/8/102" }) != "198/8/102/2") throw new InvalidOperationException("房号重名编号失败");
            if (ParkingDatabase.NextBindingRoom("198/8/102", new[] { "198/8/102", "198/8/102/2", "198/8/102/5", "198/18/102/9" }) != "198/8/102/6") throw new InvalidOperationException("编号没有按本房号最大值递增");
            try { ParkingDatabase.CanonicalBindingRoom("张先生"); throw new Exception("姓名被当作房号接受"); }
            catch (InvalidOperationException) { }
            var current = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase) {
                { "P_plate", "沪TEST01" }, { "P_Color", "绿" }, { "Car_Lei", 3 }, { "Car_Beand", "亲情车" },
                { "P_note", "原备注" }, { "P_Spaces", "车位A" }, { "P_Effective", "001001" }, { "P_Download", "001000" }
            };
            using (var command = new System.Data.SqlClient.SqlCommand())
            {
                ParkingDatabase.AddBindingProcedureParameters(command, current, "198/8/102/2");
                if ((string)command.Parameters["@owner_Name"].Value != "198/8/102/2" ||
                    (string)command.Parameters["@Car_Brand"].Value != "亲情车" ||
                    (string)command.Parameters["@P_Effective"].Value != "001001" ||
                    (string)command.Parameters["@P_Download"].Value != "001000" ||
                    (string)command.Parameters["@P_note"].Value != "原备注" || command.Parameters.Contains("@End_Time"))
                    throw new InvalidOperationException("换绑错误覆盖了车辆原值");
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

            var json = "{\"action\":\"activate_access\",\"itemId\":8,\"displayName\":\"228/16/401/6\",\"wgCardNo\":\"22355403\",\"targetBuildings\":[{\"id\":11,\"buildingNo\":\"11\",\"accessSystem\":\"iccard\"}]}";
            var task = new JavaScriptSerializer().Deserialize<AgentTask>(json);
            if (task.targetBuildings == null || task.targetBuildings.Length != 1 ||
                task.targetBuildings[0].buildingNo != "11" || task.targetBuildings[0].accessSystem != "iccard" ||
                task.displayName != "228/16/401/6")
                throw new InvalidOperationException("门禁任务楼栋快照解析失败");

            var grantJson = "{\"action\":\"authorize_existing_card\",\"operation\":\"access_database_only\",\"taskId\":19,\"displayName\":\"228/16/401/6\",\"wgCardNo\":\"22355403\",\"targetBuildings\":[{\"id\":11,\"buildingNo\":\"11\",\"accessSystem\":\"iccard\"}]}";
            var grant = new JavaScriptSerializer().Deserialize<AgentTask>(grantJson);
            if (grant.taskId != 19 || grant.action != "authorize_existing_card" || grant.targetBuildings.Length != 1 ||
                grant.displayName != "228/16/401/6" || grant.operation != "access_database_only")
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
            if (ParkingDatabase.ResolveAvailableOwnerRoomForTest("198/5/102", 20) != "198/5/102" ||
                ParkingDatabase.ResolveAvailableOwnerRoomForTest("198/5/102", 20, "198/5/102") != "198/5/102/2" ||
                ParkingDatabase.ResolveAvailableOwnerRoomForTest("198/5/102", 20, "198/5/102", "198/5/102/2") != "198/5/102/3")
                throw new InvalidOperationException("跨库同步房号冲突没有按 /2、/3 自增");
            try
            {
                ParkingDatabase.ResolveAvailableOwnerRoomForTest("198/5/102", 10, "198/5/102");
                throw new InvalidOperationException("跨库同步未拦截超长的冲突房号");
            }
            catch (InvalidOperationException exception) { if (!exception.Message.Contains("超长")) throw; }
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

        private static void VerifyParkingDownloadParameters()
        {
            if (ParkingDatabase.ProcedureParametersSql.IndexOf("is_nullable", StringComparison.OrdinalIgnoreCase) >= 0 ||
                !ParkingDatabase.ProcedureParametersSql.Contains("@name"))
                throw new InvalidOperationException("下载参数查询必须兼容 SQL Server 2008，且参数化定位过程");

            // 模拟旧版目录，仅有四列；读取第五列会直接让自检失败。
            var table = new System.Data.DataTable();
            table.Columns.Add("name", typeof(string));
            table.Columns.Add("type", typeof(string));
            table.Columns.Add("max_length", typeof(short));
            table.Columns.Add("is_output", typeof(bool));
            table.Rows.Add("@P_plate", "nvarchar", (short)100, false);
            table.Rows.Add("@Car_ID", "varchar", (short)20, false);
            table.Rows.Add("@Car_Zt", "int", (short)4, false);
            table.Rows.Add("@D_Stratime", "datetime", (short)8, false);
            table.Rows.Add("@D_Endtime", "datetime", (short)8, false);
            table.Rows.Add("@P_Effective", "varchar", (short)256, false);
            table.Rows.Add("@P_Admin", "varchar", (short)20, false);
            table.Rows.Add("@result", "nvarchar", (short)-1, true);
            List<ParkingDatabase.ProcedureParameter> parameters;
            using (var reader = table.CreateDataReader()) parameters = ParkingDatabase.ReadProcedureParameters(reader);
            var payload = new Dictionary<string, object> { { "effective", "00000011" }, { "carId", "0000000007" } };
            var startTime = new DateTime(2026, 10, 1);
            var endTime = new DateTime(2027, 9, 30, 23, 59, 59);
            var vehicle = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase) {
                { "Car_ID", "0000000007" }, { "Car_Zt", 1 }, { "Sart_Time", startTime }, { "End_Time", endTime }, { "P_Effective", "00000011" }
            };
            using (var command = new System.Data.SqlClient.SqlCommand("dbo.Add_DownloadCard"))
            {
                ParkingDatabase.AddDownloadProcedureParameters(command, parameters, vehicle, payload, "沪ATEST1", "PMS");
                if (command.Parameters.Count != 8 || (string)command.Parameters["@P_plate"].Value != "沪ATEST1" ||
                    command.Parameters["@P_plate"].SqlDbType != System.Data.SqlDbType.NVarChar || command.Parameters["@P_plate"].Size != 50 ||
                    (string)command.Parameters["@Car_ID"].Value != "0000000007" ||
                    (int)command.Parameters["@Car_Zt"].Value != 1 ||
                    (DateTime)command.Parameters["@D_Stratime"].Value != startTime ||
                    (DateTime)command.Parameters["@D_Endtime"].Value != endTime ||
                    (string)command.Parameters["@P_Effective"].Value != "00000011" ||
                    (string)command.Parameters["@P_Admin"].Value != "PMS" ||
                    command.Parameters["@result"].Direction != System.Data.ParameterDirection.Output || command.Parameters["@result"].Size != -1)
                    throw new InvalidOperationException("下载参数绑定、真实 Car_ID、Unicode 长度或输出 MAX 参数失败");
            }
            payload["carzt"] = 1; // 下面的通用过程测试没有车辆行，单独提供这个已知参数。
            payload["dstratime"] = startTime;
            payload["dendtime"] = endTime;
            parameters.Add(new ParkingDatabase.ProcedureParameter { Name = "@unknown_required", Type = System.Data.SqlDbType.Int });
            try
            {
                using (var command = new System.Data.SqlClient.SqlCommand("dbo.Add_DownloadCard"))
                    ParkingDatabase.AddMappedProcedureParameters(command, parameters, payload, "沪ATEST1", "PMS");
                throw new InvalidOperationException("未映射输入参数没有阻止执行");
            }
            catch (InvalidOperationException exception) { if (!exception.Message.Contains("@unknown_required") || !exception.Message.Contains("已停止执行")) throw; }
            table.Rows.Clear();
            table.Rows.Add("@flag", "bit", (short)1, false);
            table.Rows.Add("@id", "bigint", (short)8, false);
            table.Rows.Add("@small", "smallint", (short)2, false);
            using (var reader = table.CreateDataReader()) parameters = ParkingDatabase.ReadProcedureParameters(reader);
            if (parameters[0].Type != System.Data.SqlDbType.Bit || parameters[1].Type != System.Data.SqlDbType.BigInt || parameters[2].Type != System.Data.SqlDbType.SmallInt)
                throw new InvalidOperationException("下载参数不能把不同整数/位类型全部当作 int/varchar");
            var garages = ParkingDatabase.RequestedGarageKeys(new Dictionary<string, object> { { "garages", new object[] { "phase1", "phase2", "main", "civil" } } });
            var phase1 = ParkingDatabase.ApplyGarageSelectionForTest("1".PadRight(256, '0'), garages, "parking1");
            var phase2 = ParkingDatabase.ApplyGarageSelectionForTest("1".PadRight(256, '0'), garages, "parking2");
            if (phase1[4] != '1' || phase1[6] != '1' || phase1[8] != '0' || phase1[14] != '0')
                throw new InvalidOperationException("一期车库授权不能写入二期通道");
            if (phase2[4] != '0' || phase2[8] != '1' || phase2[14] != '1')
                throw new InvalidOperationException("二期车库授权不能写入一期通道");
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
