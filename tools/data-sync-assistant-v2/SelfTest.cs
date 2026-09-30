using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
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

        private static void VerifyRuntimeMapping(ConfigurationStore store, AssistantConfiguration config)
        {
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

            var capabilities = AgentLoop.BuildCapabilities(mapped, true, false, true);
            if (!capabilities["accessDbWrite"] || capabilities["controllerUpload"])
                throw new InvalidOperationException("门禁数据库与控制器能力没有独立上报");

            var json = "{\"action\":\"activate_access\",\"itemId\":8,\"wgCardNo\":\"22355403\",\"targetBuildings\":[{\"id\":11,\"buildingNo\":\"11\",\"accessSystem\":\"iccard\"}]}";
            var task = new JavaScriptSerializer().Deserialize<AgentTask>(json);
            if (task.targetBuildings == null || task.targetBuildings.Length != 1 ||
                task.targetBuildings[0].buildingNo != "11" || task.targetBuildings[0].accessSystem != "iccard")
                throw new InvalidOperationException("门禁任务楼栋快照解析失败");
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
    }
}
