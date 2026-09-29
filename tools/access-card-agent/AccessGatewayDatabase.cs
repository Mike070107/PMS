using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.IO;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessDatabaseProbeResult
    {
        public string Name { get; set; }
        public string Path { get; set; }
        public long Length { get; set; }
        public Dictionary<string, int> Counts { get; set; }
    }

    /** .88 门禁数据库只读探测；不执行 INSERT/UPDATE/DELETE。 */
    internal static class AccessGatewayDatabase
    {
        public static AccessDatabaseProbeResult ProbeMjSystem(AgentConfig config)
        {
            return Probe(
                "MjSystem",
                config.MjSystemDatabasePath,
                null,
                new[] { "Employee", "MJ_MacPower", "MJ_MacInfo", "MJ_DoorInfo" });
        }

        public static AccessDatabaseProbeResult ProbeIcCard(AgentConfig config, string password)
        {
            return Probe(
                "iCCard",
                config.IcCardDatabasePath,
                password,
                new[] { "t_b_Consumer", "t_b_IDCard", "t_d_Privilege" });
        }

        private static AccessDatabaseProbeResult Probe(
            string name,
            string path,
            string password,
            string[] tables)
        {
            if (String.IsNullOrWhiteSpace(path))
                throw new InvalidOperationException(name + " 数据库路径未配置");
            if (!File.Exists(path))
                throw new FileNotFoundException(name + " 数据库不存在", path);

            var builder = new OleDbConnectionStringBuilder
            {
                Provider = "Microsoft.Jet.OLEDB.4.0",
                DataSource = path
            };
            if (!String.IsNullOrEmpty(password))
                builder["Jet OLEDB:Database Password"] = password;

            var result = new AccessDatabaseProbeResult
            {
                Name = name,
                Path = path,
                Length = new FileInfo(path).Length,
                Counts = new Dictionary<string, int>()
            };
            using (var connection = new OleDbConnection(builder.ConnectionString))
            {
                connection.Open();
                foreach (var table in tables)
                {
                    using (var command = connection.CreateCommand())
                    {
                        // 表名来自程序内置白名单，不接受外部 SQL。
                        command.CommandText = "SELECT COUNT(*) FROM [" + table + "]";
                        result.Counts[table] = Convert.ToInt32(command.ExecuteScalar());
                    }
                }
            }
            return result;
        }
    }
}
