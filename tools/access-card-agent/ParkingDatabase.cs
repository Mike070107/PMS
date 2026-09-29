using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;

namespace Pms.AccessCardAgent
{
    internal sealed class ParkingDatabaseProbeResult
    {
        public string Database { get; set; }
        public long VehicleCount { get; set; }
        public long DownloadCount { get; set; }
        public Dictionary<string, bool> Procedures { get; set; }
    }

    /** 停车双库只读探测。真实写入必须通过现场验收后另行开启。 */
    internal static class ParkingDatabase
    {
        private static readonly string[] RequiredProcedures =
        {
            "AddIssue", "Palte_extend", "Up_PakIssue", "Add_Del_Plate",
            "Add_DownloadCard", "Add_Release", "Get_Download"
        };

        public static ParkingDatabaseProbeResult Probe(AgentConfig config, string password, string database)
        {
            Validate(config, password, database);
            var result = new ParkingDatabaseProbeResult
            {
                Database = database,
                Procedures = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase)
            };
            using (var connection = new SqlConnection(ConnectionString(config, password, database)))
            {
                connection.Open();
                result.VehicleCount = CountIfPresent(connection, "Car_Issue");
                result.DownloadCount = CountIfPresent(connection, "Car_Download");
                foreach (var procedure in RequiredProcedures)
                    result.Procedures[procedure] = ObjectExists(connection, procedure, "P");
            }
            return result;
        }

        public static ParkingDatabaseProbeResult[] ProbeBoth(AgentConfig config, string password)
        {
            return new[]
            {
                Probe(config, password, config.ParkingPhase1Database),
                Probe(config, password, config.ParkingPhase2Database)
            };
        }

        private static void Validate(AgentConfig config, string password, string database)
        {
            if (String.IsNullOrWhiteSpace(config.ParkingSqlServer) ||
                String.IsNullOrWhiteSpace(database) ||
                String.IsNullOrWhiteSpace(config.ParkingUser))
                throw new InvalidOperationException("停车数据库配置缺少服务器、数据库或用户");
            if (String.IsNullOrWhiteSpace(password))
                throw new InvalidOperationException("停车数据库密码为空");
        }

        private static string ConnectionString(AgentConfig config, string password, string database)
        {
            return new SqlConnectionStringBuilder
            {
                DataSource = config.ParkingSqlServer,
                InitialCatalog = database,
                UserID = config.ParkingUser,
                Password = password,
                ConnectTimeout = 5,
                Encrypt = false,
                TrustServerCertificate = true,
                ApplicationName = "PMS Parking Gateway ReadOnly Probe"
            }.ConnectionString;
        }

        private static long CountIfPresent(SqlConnection connection, string table)
        {
            if (!ObjectExists(connection, table, "U")) return -1;
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT COUNT_BIG(1) FROM " + QuoteName(table) + ";";
                command.CommandTimeout = 10;
                return Convert.ToInt64(command.ExecuteScalar());
            }
        }

        private static bool ObjectExists(SqlConnection connection, string name, string type)
        {
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM sys.objects
  WHERE [name] = @name AND [type] = @type
) THEN 1 ELSE 0 END;";
                command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
                command.Parameters.Add("@type", SqlDbType.Char, 2).Value = type;
                return Convert.ToInt32(command.ExecuteScalar()) == 1;
            }
        }

        private static string QuoteName(string value)
        {
            return "[dbo].[" + value.Replace("]", "]]" ) + "]";
        }
    }
}
