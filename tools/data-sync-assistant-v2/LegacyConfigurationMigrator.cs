using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Pms.DataSyncAssistant
{
    public sealed class LegacyMigrationResult
    {
        public int Imported { get; set; }
        public int Skipped { get; set; }
        public List<string> Warnings { get; private set; }
        public LegacyMigrationResult() { Warnings = new List<string>(); }
    }

    public sealed class LegacyConfigurationMigrator
    {
        private static readonly byte[] LegacyEntropy = Encoding.UTF8.GetBytes("PMS.AccessCardAgent.v1");
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly ConfigurationStore _store;

        public LegacyConfigurationMigrator(ConfigurationStore store) { _store = store; }

        public LegacyMigrationResult ImportKnownLocations(AssistantConfiguration target)
        {
            var result = new LegacyMigrationResult();
            foreach (var directory in CandidateDirectories())
                ImportDirectory(directory, target, result);
            if (result.Imported > 0) _store.Save(target);
            return result;
        }

        internal void ImportDirectory(string directory, AssistantConfiguration target, LegacyMigrationResult result)
        {
            var configPath = Path.Combine(directory, "agent.config.json");
            if (!File.Exists(configPath)) return;
            try
            {
                var source = _json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath, Encoding.UTF8));
                var kind = Value(source, "Kind");
                var type = MapType(kind);
                if (type == null) { result.Skipped++; return; }
                var server = kind == "parking_gateway" ? Value(source, "ParkingSqlServer") : Value(source, "LegacySqlServer");
                var database1 = kind == "parking_gateway" ? Value(source, "ParkingPhase1Database") : Value(source, "LegacyDatabase");
                var database2 = kind == "parking_gateway" ? Value(source, "ParkingPhase2Database") : "";
                var fingerprint = type + "|" + server + "|" + database1 + "|" + database2;
                if (target.Connections.Any(existingConnection => Get(existingConnection, "legacyFingerprint") == fingerprint)) { result.Skipped++; return; }

                var item = new ConnectionConfiguration
                {
                    Type = type,
                    Name = FriendlyName(type, Value(source, "Name")),
                    HostName = target.Host.Name,
                    HostIp = target.Host.IpAddress,
                    DataLocation = String.IsNullOrWhiteSpace(server) ? "本机数据文件" : "SQL Server " + server,
                    Status = "已迁移，等待测试",
                    StatusTone = "warning",
                    Summary = "已从旧版助手导入参数"
                };
                item.Parameters["server"] = server;
                item.Parameters["database1"] = database1;
                item.Parameters["database2"] = database2;
                item.Parameters["user"] = kind == "parking_gateway" ? Value(source, "ParkingUser") : Value(source, "LegacyUser");
                item.Parameters["agentId"] = Value(source, "AgentId");
                item.Parameters["legacyFingerprint"] = fingerprint;
                target.Connections.Add(item);

                ImportSecret(directory, "agent.token.dat", "connection:" + item.Id + ":agentToken", result);
                ImportSecret(directory, kind == "parking_gateway" ? "parking-db-password.dat" : "legacy-db-password.dat", "connection:" + item.Id + ":password", result);
                result.Imported++;
            }
            catch (Exception exception)
            {
                result.Warnings.Add(Path.GetFileName(directory) + "：" + exception.Message);
            }
        }

        private void ImportSecret(string directory, string fileName, string targetKey, LegacyMigrationResult result)
        {
            var path = Path.Combine(directory, fileName);
            if (!File.Exists(path)) return;
            try
            {
                var plain = ProtectedData.Unprotect(File.ReadAllBytes(path), LegacyEntropy, DataProtectionScope.LocalMachine);
                _store.SetSecret(targetKey, Encoding.UTF8.GetString(plain));
            }
            catch (Exception exception)
            {
                result.Warnings.Add(fileName + " 无法迁移：" + exception.Message);
            }
        }

        private static IEnumerable<string> CandidateDirectories()
        {
            var roots = new List<string>();
            var baseDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            roots.Add(baseDirectory);
            var parent = Directory.GetParent(baseDirectory);
            if (parent != null) roots.Add(parent.FullName);
            foreach (var path in new[] { @"C:\PMS-AccessCardAgent", @"D:\PMS-AccessCardAgent" })
                if (Directory.Exists(path)) roots.Add(path);

            var yielded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var root in roots.Where(Directory.Exists))
            {
                if (yielded.Add(root)) yield return root;
                string[] children;
                try { children = Directory.GetDirectories(root); }
                catch { continue; }
                foreach (var child in children)
                    if (yielded.Add(child)) yield return child;
            }
        }

        private static string MapType(string kind)
        {
            if (kind == "parking_gateway") return ConnectionTypes.Parking;
            if (kind == "legacy_sync") return ConnectionTypes.LegacyAccess;
            if (kind == "access_gateway") return ConnectionTypes.BuildingAccess;
            if (kind == "issuer") return ConnectionTypes.CardReader;
            return null;
        }

        private static string FriendlyName(string type, string fallback)
        {
            if (type == ConnectionTypes.LegacyAccess) return "枫桦一二期小区大门门禁系统接入";
            if (type == ConnectionTypes.BuildingAccess) return "枫桦二期楼栋门禁系统接入";
            return String.IsNullOrWhiteSpace(fallback) ? ConnectionTypes.Label(type) : fallback;
        }

        private static string Value(Dictionary<string, object> source, string key)
        {
            object value; return source != null && source.TryGetValue(key, out value) && value != null ? value.ToString().Trim() : "";
        }

        private static string Get(ConnectionConfiguration item, string key)
        {
            string value; return item.Parameters.TryGetValue(key, out value) ? value : "";
        }
    }
}
