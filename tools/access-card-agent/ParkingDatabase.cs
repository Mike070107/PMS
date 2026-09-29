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

    internal sealed class ParkingSearchRow
    {
        public string database { get; set; }
        public Dictionary<string, object> fields { get; set; }
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

        public static List<ParkingSearchRow> SearchBoth(AgentConfig config, string password, string term)
        {
            if (String.IsNullOrWhiteSpace(term) || term.Trim().Length < 2)
                throw new InvalidOperationException("请输入至少 2 个字符查询停车数据");
            var rows = new List<ParkingSearchRow>();
            rows.AddRange(Search(config, password, config.ParkingPhase1Database, term.Trim()));
            rows.AddRange(Search(config, password, config.ParkingPhase2Database, term.Trim()));
            return rows;
        }

        public static List<ParkingSearchRow> Search(AgentConfig config, string password, string database, string term)
        {
            Validate(config, password, database);
            using (var connection = new SqlConnection(ConnectionString(config, password, database)))
            {
                connection.Open();
                if (!ObjectExists(connection, "Car_Issue", "U"))
                    throw new InvalidOperationException(database + " 中不存在 Car_Issue 表");
                var columns = LoadColumns(connection);
                var searchable = columns.FindAll(delegate(ParkingColumn column) { return column.Searchable; });
                if (searchable.Count > 40) searchable.RemoveRange(40, searchable.Count - 40);
                if (searchable.Count == 0)
                    throw new InvalidOperationException(database + " 的 Car_Issue 没有可查询的文本字段");

                var variants = SearchVariants(term);
                using (var command = connection.CreateCommand())
                {
                    var predicates = new List<string>();
                    for (var valueIndex = 0; valueIndex < variants.Count; valueIndex++)
                    {
                        var parameterName = "@term" + valueIndex;
                        command.Parameters.Add(parameterName, SqlDbType.NVarChar, 200).Value = "%" + EscapeLike(variants[valueIndex]) + "%";
                        foreach (var column in searchable)
                            predicates.Add("CONVERT(NVARCHAR(4000), " + QuoteColumn(column.Name) + ") LIKE " + parameterName + " ESCAPE N'~'");
                    }
                    command.CommandText = "SELECT TOP 50 * FROM [dbo].[Car_Issue] WITH (NOLOCK) WHERE " + String.Join(" OR ", predicates.ToArray()) + ";";
                    command.CommandTimeout = 15;
                    var rows = new List<ParkingSearchRow>();
                    using (var reader = command.ExecuteReader(CommandBehavior.SequentialAccess))
                    {
                        while (reader.Read())
                        {
                            var fields = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                            for (var index = 0; index < reader.FieldCount && fields.Count < 60; index++)
                            {
                                if (reader.IsDBNull(index)) continue;
                                var value = SafeValue(reader.GetValue(index));
                                if (value != null) fields[reader.GetName(index)] = value;
                            }
                            rows.Add(new ParkingSearchRow { database = database, fields = fields });
                        }
                    }
                    return rows;
                }
            }
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

        private sealed class ParkingColumn
        {
            public string Name { get; set; }
            public bool Searchable { get; set; }
        }

        private static List<ParkingColumn> LoadColumns(SqlConnection connection)
        {
            var columns = new List<ParkingColumn>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT c.[name], t.[name]
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
WHERE c.object_id = OBJECT_ID(N'[dbo].[Car_Issue]')
ORDER BY c.column_id;";
                command.CommandTimeout = 10;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var type = reader.GetString(1).ToLowerInvariant();
                        columns.Add(new ParkingColumn
                        {
                            Name = reader.GetString(0),
                            Searchable = type == "varchar" || type == "nvarchar" || type == "char" ||
                                type == "nchar" || type == "text" || type == "ntext"
                        });
                    }
                }
            }
            return columns;
        }

        private static List<string> SearchVariants(string term)
        {
            var result = new List<string>();
            AddVariant(result, term);
            AddVariant(result, term.Replace('/', '-'));
            AddVariant(result, term.Replace('-', '/'));
            AddVariant(result, term.Replace(" ", ""));
            return result;
        }

        internal static List<string> SearchVariantsForTest(string term)
        {
            return SearchVariants(term);
        }

        private static void AddVariant(List<string> values, string value)
        {
            if (!String.IsNullOrWhiteSpace(value) && !values.Contains(value)) values.Add(value);
        }

        private static string EscapeLike(string value)
        {
            return value.Replace("~", "~~").Replace("%", "~%").Replace("_", "~_").Replace("[", "~[");
        }

        internal static string EscapeLikeForTest(string value)
        {
            return EscapeLike(value);
        }

        private static object SafeValue(object value)
        {
            if (value == null || value == DBNull.Value || value is byte[]) return null;
            if (value is DateTime) return ((DateTime)value).ToString("yyyy-MM-dd HH:mm:ss");
            if (value is Guid) return value.ToString();
            var text = value as string;
            if (text == null) return value;
            text = text.Trim();
            return text.Length <= 500 ? text : text.Substring(0, 500);
        }

        private static string QuoteColumn(string value)
        {
            return "[" + value.Replace("]", "]]" ) + "]";
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
