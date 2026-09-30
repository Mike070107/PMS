using System;
using System.IO;

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
            }
            finally
            {
                var full = Path.GetFullPath(root);
                var temp = Path.GetFullPath(Path.GetTempPath());
                if (full.StartsWith(temp, StringComparison.OrdinalIgnoreCase) && Directory.Exists(full))
                    Directory.Delete(full, true);
            }
        }
    }
}
