using System;
using System.Collections;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

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

    internal sealed class ParkingOwnerConflictException : InvalidOperationException
    {
        public ParkingOwnerConflictException(string message) : base(message) { }
    }

    /** 停车双库查询、车辆存储过程和住户资料写入能力。 */
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

        public static bool CanWriteBoth(AgentConfig config, string password)
        {
            return CanWrite(config, password, config.ParkingPhase1Database) &&
                CanWrite(config, password, config.ParkingPhase2Database);
        }

        public static bool CanWrite(AgentConfig config, string password, string database)
        {
            Validate(config, password, database);
            using (var connection = new SqlConnection(ConnectionString(config, password, database)))
            {
                connection.Open();
                // 车辆登记、续期和注销仍走旧系统存储过程，以便维护下载队列和设备状态。
                var procedures = new[] { "AddIssue", "Palte_extend", "Up_PakIssue", "Add_Del_Plate", "Add_DownloadCard", "Add_Release", "Get_Download" };
                foreach (var procedure in procedures)
                {
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT HAS_PERMS_BY_NAME(@object, 'OBJECT', 'EXECUTE');";
                        command.Parameters.Add("@object", SqlDbType.NVarChar, 300).Value = "dbo." + procedure;
                        if (Convert.ToInt32(command.ExecuteScalar()) != 1) return false;
                    }
                }
                // 住户资料位于 Car_Issue.Owner_ID 关联表；该类资料没有对应旧系统存储过程，
                // 因此单独验证目标表 UPDATE 权限，网页只有两类权限都具备时才开放编辑。
                var ownerSource = FindOwnerSource(connection);
                if (ownerSource == null) return false;
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT HAS_PERMS_BY_NAME(@object, 'OBJECT', 'UPDATE');";
                    command.Parameters.Add("@object", SqlDbType.NVarChar, 300).Value = ownerSource.Schema + "." + ownerSource.Table;
                    if (Convert.ToInt32(command.ExecuteScalar()) != 1) return false;
                }
                return true;
            }
        }

        public static Dictionary<string, string> DescribeProcedures(AgentConfig config, string password, string database)
        {
            Validate(config, password, database);
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            using (var connection = new SqlConnection(ConnectionString(config, password, database)))
            {
                connection.Open();
                foreach (var procedure in RequiredProcedures)
                {
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = @"
SELECT p.[name], TYPE_NAME(p.user_type_id), p.max_length, p.[precision], p.scale, p.is_output
FROM sys.parameters p
WHERE p.object_id = OBJECT_ID(@qualified)
ORDER BY p.parameter_id;";
                        command.Parameters.Add("@qualified", SqlDbType.NVarChar, 300).Value = "dbo." + procedure;
                        command.CommandTimeout = 10;
                        var parameters = new List<string>();
                        using (var reader = command.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var value = reader.GetString(0) + " " + reader.GetString(1);
                                var length = reader.GetInt16(2);
                                if (length > 0) value += "(" + length + ")";
                                if (reader.GetBoolean(5)) value += " OUTPUT";
                                parameters.Add(value);
                            }
                        }
                        result[procedure] = parameters.Count == 0 ? "无参数，或当前账号无权查看定义" : String.Join(", ", parameters.ToArray());
                    }
                }
            }
            return result;
        }

        public static List<ParkingSearchRow> SearchBoth(AgentConfig config, string password, string term)
        {
            var plan = BuildSearchPlan(term);
            var rows = new List<ParkingSearchRow>();
            rows.AddRange(Search(config, password, config.ParkingPhase1Database, plan));
            rows.AddRange(Search(config, password, config.ParkingPhase2Database, plan));
            return rows;
        }

        // 通行流水在捷顺 TC.View_RecordAll，不属于 parking1/parking2 的 Car_Issue 授权数据。
        // 每期使用独立的只读连接；未配置历史库时仅尝试现有库，视图不存在则明确报错。
        public static List<ParkingSearchRow> SearchMovementsBoth(AgentConfig config, string password, string movementPassword,
            string plate, string startDate, string endDate)
        {
            if (!Regex.IsMatch(plate ?? "", @"^[\u4e00-\u9fa5][A-Z][A-Z0-9]{5,6}$"))
                throw new InvalidOperationException("进出记录必须按完整车牌精确查询");
            DateTime start, end;
            if (!DateTime.TryParseExact(startDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out start) ||
                !DateTime.TryParseExact(endDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out end) ||
                end < start || (end - start).TotalDays > 30)
                throw new InvalidOperationException("进出记录日期范围不正确，最多查询连续 31 天");
            var rows = new List<ParkingSearchRow>();
            rows.AddRange(SearchMovements(config, password, movementPassword, plate, start, end.AddDays(1), true));
            rows.AddRange(SearchMovements(config, password, movementPassword, plate, start, end.AddDays(1), false));
            return rows.OrderByDescending(row => Convert.ToString(row.fields["outTime"] ?? row.fields["inTime"], CultureInfo.InvariantCulture))
                .Take(100).ToList();
        }

        // 金额报表只读旧库；汇总和每日金额由 SQL 对完整区间聚合，明细仅返回最近 30 条。
        // 临停 Charge1 是旧网页的“应收金额”，不是支付成功金额。
        public static List<ParkingSearchRow> SearchFeeReport(AgentConfig config, string password, string movementPassword,
            string startDate, string endDate)
        {
            DateTime start, end;
            if (!DateTime.TryParseExact(startDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out start) ||
                !DateTime.TryParseExact(endDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out end) ||
                end < start || (end - start).TotalDays > 30)
                throw new InvalidOperationException("金额报表每次最多查询连续 31 天");
            var rows = new List<ParkingSearchRow>();
            foreach (var phase1 in new[] { true, false })
            {
                var label = phase1 ? "parking1" : "parking2";
                var parkingDatabase = phase1 ? config.ParkingPhase1Database : config.ParkingPhase2Database;
                Validate(config, password, parkingDatabase);
                using (var connection = new SqlConnection(ConnectionString(config, password, parkingDatabase)))
                {
                    connection.Open();
                    var dateColumn = FeeRenewalDateColumn(connection);
                    ReadFeeRows(connection, label, "renewal", "[dbo].[P_moneyKeep]", dateColumn,
                        "[P_money]", "[P_plate]", "[P_Admin]", " AND [type] = 5", start, end.AddDays(1), rows);
                }

                var server = phase1 ? config.ParkingMovementPhase1Server : config.ParkingMovementPhase2Server;
                var database = phase1 ? config.ParkingMovementPhase1Database : config.ParkingMovementPhase2Database;
                var custom = !String.IsNullOrWhiteSpace(server) || !String.IsNullOrWhiteSpace(database);
                if (custom && (String.IsNullOrWhiteSpace(server) || String.IsNullOrWhiteSpace(database)))
                    throw new InvalidOperationException(label + " 的临停历史库地址与库名必须同时配置");
                if (!custom) { server = config.ParkingSqlServer; database = parkingDatabase; }
                var user = String.IsNullOrWhiteSpace(config.ParkingMovementUser) ? config.ParkingUser : config.ParkingMovementUser;
                var secret = custom && !String.IsNullOrWhiteSpace(movementPassword) ? movementPassword : password;
                if (String.IsNullOrWhiteSpace(server) || String.IsNullOrWhiteSpace(database) || String.IsNullOrWhiteSpace(user) || String.IsNullOrWhiteSpace(secret))
                    throw new InvalidOperationException(label + " 的临停历史库尚未配置完整");
                var builder = new SqlConnectionStringBuilder { DataSource = server, InitialCatalog = database,
                    UserID = user, Password = secret, ConnectTimeout = 5, Encrypt = false,
                    TrustServerCertificate = true, ApplicationName = "PMS Parking Fee Read" };
                using (var connection = new SqlConnection(builder.ConnectionString))
                {
                    connection.Open();
                    try
                    {
                        ReadFeeRows(connection, label, "temporary", "[TC].[View_RecordOut_temp]", "[OutTime]",
                            "[Charge1]", "[CarNo]", "NULL", "", start, end.AddDays(1), rows);
                    }
                    catch (SqlException exception)
                    {
                        if (exception.Number == 208 || exception.Number == 229 || exception.Number == 207)
                            throw new InvalidOperationException(label + " 无法读取临停收费视图 TC.View_RecordOut_temp；请配置捷顺历史库只读账号", exception);
                        throw;
                    }
                }
            }
            var daily = rows.Where(row => Convert.ToString(row.fields["kind"]) == "daily")
                .GroupBy(row => Convert.ToString(row.fields["category"]) + "|" + Convert.ToString(row.fields["day"]))
                .Select(group => new ParkingSearchRow { database = "both", fields = new Dictionary<string, object> {
                    { "kind", "daily" }, { "category", group.First().fields["category"] },
                    { "day", group.First().fields["day"] }, { "count", group.Sum(row => Convert.ToInt64(row.fields["count"])) },
                    { "amountCents", group.Sum(row => Convert.ToInt64(row.fields["amountCents"])) }
                } }).ToList();
            var detail = rows.Where(row => Convert.ToString(row.fields["kind"]) == "detail")
                .OrderByDescending(row => Convert.ToString(row.fields["occurredAt"])).Take(30).ToList();
            return rows.Where(row => Convert.ToString(row.fields["kind"]) == "summary").Concat(daily).Concat(detail).ToList();
        }

        private static string FeeRenewalDateColumn(SqlConnection connection)
        {
            var columns = new List<string>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"SELECT c.name FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id
WHERE c.object_id=OBJECT_ID('dbo.P_moneyKeep') AND t.name IN ('datetime','smalldatetime','date','datetime2');";
                using (var reader = command.ExecuteReader()) while (reader.Read()) columns.Add(reader.GetString(0));
            }
            if (columns.Count == 0) throw new InvalidOperationException("P_moneyKeep 不存在，或没有可识别的续期操作时间字段");
            var preferred = new[] { "P_Date", "P_Time", "P_CreateTime", "CreateTime", "AddTime", "Time", "Date" };
            var chosen = preferred.Select(name => columns.FirstOrDefault(column => column.Equals(name, StringComparison.OrdinalIgnoreCase)))
                .FirstOrDefault(column => column != null);
            if (chosen == null && columns.Count == 1) chosen = columns[0];
            if (chosen == null) throw new InvalidOperationException("P_moneyKeep 有多个日期字段，无法确定续期操作时间；请核对旧库表结构");
            return "[" + chosen.Replace("]", "]]" ) + "]";
        }

        private static void ReadFeeRows(SqlConnection connection, string database, string category, string table,
            string dateColumn, string amountColumn, string plateColumn, string operatorColumn, string extraFilter,
            DateTime start, DateTime endExclusive, List<ParkingSearchRow> rows)
        {
            var where = dateColumn + " >= @start AND " + dateColumn + " < @end" + extraFilter;
            var money = "CONVERT(decimal(18,2), " + amountColumn + ")";
            using (var command = connection.CreateCommand())
            {
                command.CommandTimeout = 30;
                command.CommandText = "SELECT COUNT_BIG(*), COALESCE(SUM(" + money + "),0) FROM " + table + " WHERE " + where;
                command.Parameters.Add("@start", SqlDbType.DateTime).Value = start;
                command.Parameters.Add("@end", SqlDbType.DateTime).Value = endExclusive;
                using (var reader = command.ExecuteReader())
                {
                    reader.Read();
                    rows.Add(FeeRow(database, "summary", category, null, null, null, null,
                        Convert.ToInt64(reader[0]), Convert.ToDecimal(reader[1])));
                }
                command.CommandText = "SELECT CONVERT(varchar(10)," + dateColumn + ",120), COUNT_BIG(*), COALESCE(SUM(" + money + "),0) FROM " + table +
                    " WHERE " + where + " GROUP BY CONVERT(varchar(10)," + dateColumn + ",120)";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) rows.Add(FeeRow(database, "daily", category, Convert.ToString(reader[0]),
                        null, null, null, Convert.ToInt64(reader[1]), Convert.ToDecimal(reader[2])));
                command.CommandText = "SELECT TOP (30) " + dateColumn + ", " + plateColumn + ", " + operatorColumn + ", " + money +
                    " FROM " + table + " WHERE " + where + " ORDER BY " + dateColumn + " DESC";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) rows.Add(FeeRow(database, "detail", category, null,
                        reader[0] == DBNull.Value ? null : Convert.ToDateTime(reader[0]).ToString("yyyy-MM-dd HH:mm:ss"),
                        reader[1] == DBNull.Value ? null : Convert.ToString(reader[1]),
                        reader[2] == DBNull.Value ? null : Convert.ToString(reader[2]), 1, Convert.ToDecimal(reader[3])));
            }
        }

        private static ParkingSearchRow FeeRow(string database, string kind, string category, string day,
            string occurredAt, string plate, string operatorName, long count, decimal amount)
        {
            return new ParkingSearchRow { database = database, fields = new Dictionary<string, object> {
                { "kind", kind }, { "category", category }, { "day", day }, { "occurredAt", occurredAt },
                { "plate", plate }, { "operator", operatorName }, { "count", count },
                { "amountCents", decimal.ToInt64(decimal.Round(amount * 100m, 0, MidpointRounding.AwayFromZero)) }
            } };
        }

        private static List<ParkingSearchRow> SearchMovements(AgentConfig config, string password, string movementPassword,
            string plate, DateTime start, DateTime endExclusive, bool phase1)
        {
            var databaseLabel = phase1 ? "parking1" : "parking2";
            var server = phase1 ? config.ParkingMovementPhase1Server : config.ParkingMovementPhase2Server;
            var database = phase1 ? config.ParkingMovementPhase1Database : config.ParkingMovementPhase2Database;
            var custom = !String.IsNullOrWhiteSpace(server) || !String.IsNullOrWhiteSpace(database);
            if (custom && (String.IsNullOrWhiteSpace(server) || String.IsNullOrWhiteSpace(database)))
                throw new InvalidOperationException(databaseLabel + " 的进出记录库地址和库名必须同时配置");
            if (!custom) { server = config.ParkingSqlServer; database = phase1 ? config.ParkingPhase1Database : config.ParkingPhase2Database; }
            var user = String.IsNullOrWhiteSpace(config.ParkingMovementUser) ? config.ParkingUser : config.ParkingMovementUser;
            var secret = custom && !String.IsNullOrWhiteSpace(movementPassword) ? movementPassword : password;
            if (String.IsNullOrWhiteSpace(server) || String.IsNullOrWhiteSpace(database) || String.IsNullOrWhiteSpace(user) || String.IsNullOrWhiteSpace(secret))
                throw new InvalidOperationException(databaseLabel + " 的进出记录数据库尚未配置完整");
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = server, InitialCatalog = database, UserID = user, Password = secret,
                ConnectTimeout = 5, Encrypt = false, TrustServerCertificate = true,
                ApplicationName = "PMS Parking Movement Read"
            };
            using (var connection = new SqlConnection(builder.ConnectionString))
            {
                connection.Open();
                using (var command = connection.CreateCommand())
                {
                    command.CommandTimeout = 15;
                    command.CommandText = @"SELECT TOP (50) CarNO, CardTypeName, PersonName, InTime, OutTime
FROM [TC].[View_RecordAll]
WHERE CarNO = @plate AND ((InTime >= @start AND InTime < @end) OR (OutTime >= @start AND OutTime < @end))
ORDER BY COALESCE(OutTime, InTime) DESC;";
                    command.Parameters.Add("@plate", SqlDbType.NVarChar, 20).Value = plate;
                    command.Parameters.Add("@start", SqlDbType.DateTime).Value = start;
                    command.Parameters.Add("@end", SqlDbType.DateTime).Value = endExclusive;
                    var rows = new List<ParkingSearchRow>();
                    try
                    {
                        using (var reader = command.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var fields = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase) {
                                    { "carNo", Convert.ToString(reader["CarNO"]).Trim().ToUpperInvariant() },
                                    { "cardTypeName", reader["CardTypeName"] == DBNull.Value ? null : Convert.ToString(reader["CardTypeName"]) },
                                    { "personName", reader["PersonName"] == DBNull.Value ? null : Convert.ToString(reader["PersonName"]) },
                                    { "inTime", reader["InTime"] == DBNull.Value ? null : Convert.ToDateTime(reader["InTime"]).ToString("yyyy-MM-dd HH:mm:ss") },
                                    { "outTime", reader["OutTime"] == DBNull.Value ? null : Convert.ToDateTime(reader["OutTime"]).ToString("yyyy-MM-dd HH:mm:ss") }
                                };
                                rows.Add(new ParkingSearchRow { database = databaseLabel, fields = fields });
                            }
                        }
                    }
                    catch (SqlException exception)
                    {
                        if (exception.Number == 208 || exception.Number == 229)
                            throw new InvalidOperationException(databaseLabel + " 的进出记录库无法读取 TC.View_RecordAll，请在助手设置中配置捷顺历史库和只读账号", exception);
                        throw;
                    }
                    return rows;
                }
            }
        }

        public static List<ParkingSearchRow> Search(AgentConfig config, string password, string database, string term)
        {
            return Search(config, password, database, BuildSearchPlan(term));
        }

        private static List<ParkingSearchRow> Search(AgentConfig config, string password, string database, ParkingSearchPlan plan)
        {
            Validate(config, password, database);
            // 用户输入完整弄号时，只查询对应停车库；同时允许该库的 P_Owner.owner_Name
            // 省略弄号（例如 parking1 的 12/101 等同于 198/12/101）。
            if (!SearchAppliesToDatabase(plan, database, config.ParkingPhase1Database, config.ParkingPhase2Database))
                return new List<ParkingSearchRow>();
            using (var connection = new SqlConnection(ConnectionString(config, password, database)))
            {
                connection.Open();
                if (!ObjectExists(connection, "Car_Issue", "U"))
                    throw new InvalidOperationException(database + " 中不存在 Car_Issue 表");
                var columns = LoadColumns(connection, "dbo", "Car_Issue");
                var searchable = columns.FindAll(delegate(ParkingColumn column) { return column.Searchable; });
                var ownerSource = FindOwnerSource(connection);
                var ownerSearchable = ownerSource == null
                    ? new List<ParkingColumn>()
                    : ownerSource.Columns.FindAll(delegate(ParkingColumn column) { return column.Searchable; });
                if (searchable.Count + ownerSearchable.Count > 40)
                {
                    var ownerLimit = Math.Max(0, 40 - searchable.Count);
                    if (ownerSearchable.Count > ownerLimit)
                        ownerSearchable.RemoveRange(ownerLimit, ownerSearchable.Count - ownerLimit);
                }
                if (searchable.Count == 0 && ownerSearchable.Count == 0)
                    throw new InvalidOperationException(database + " 的 Car_Issue 没有可查询的文本字段");

                var targetColumns = SearchColumns(plan.Kind, searchable, ownerSearchable);
                if (targetColumns.Count == 0)
                    throw new InvalidOperationException(database + " 没有适合“" + SearchKindLabel(plan.Kind) + "”查询的字段");
                using (var command = connection.CreateCommand())
                {
                    var predicates = new List<string>();
                    for (var valueIndex = 0; valueIndex < plan.Patterns.Count; valueIndex++)
                    {
                        var parameterName = "@term" + valueIndex;
                        command.Parameters.Add(parameterName, SqlDbType.NVarChar, 200).Value = plan.Patterns[valueIndex];
                        foreach (var target in targetColumns)
                            predicates.Add("CONVERT(NVARCHAR(4000), " + target.Alias + "." + QuoteColumn(target.Column.Name) + ") LIKE " + parameterName + " ESCAPE N'~'");
                    }
                    // 只返回停车页面真正需要的字段。旧版使用 `c.*` 后再追加住户字段，
                    // 读结果时的字段上限会把 Owner__owner_Name / Owner__owner_Tel 截掉，
                    // 于是明明能联表的房号和电话在上传前就丢了。
                    var select = BuildParkingSelect(columns, ownerSource);
                    var join = "";
                    if (ownerSource != null)
                    {
                        join = " LEFT JOIN " + QuoteName(ownerSource.Schema, ownerSource.Table) + " o WITH (NOLOCK) ON " +
                            "CONVERT(NVARCHAR(200), c.[Owner_ID]) = CONVERT(NVARCHAR(200), o." + QuoteColumn(ownerSource.KeyColumn) + ")";
                    }
                    command.CommandText = "SELECT TOP 50 " + select + " FROM [dbo].[Car_Issue] c WITH (NOLOCK)" + join +
                        " WHERE " + String.Join(" OR ", predicates.ToArray()) + ";";
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
                    // 住户表偶尔存在同一 UserID 的历史重复行，LEFT JOIN 会把同一辆车展开成多张完全相同的卡片。
                    // 以旧库车辆主键去重，并合并重复行里各自不为空的住户字段，既不丢真实多卡记录，也不重复展示同一条车牌。
                    rows = DeduplicateRows(rows);
                    AttachPlateChangeTimes(connection, rows);
                    return rows;
                }
            }
        }

        private static string BuildParkingSelect(List<ParkingColumn> issueColumns, ParkingOwnerSource ownerSource)
        {
            var parts = new List<string>();

            // 住户字段排在最前，且只带能用于房号、电话和关联的字段。
            if (ownerSource != null)
            {
                var ownerColumns = ownerSource.Columns
                    .OrderByDescending(delegate(ParkingColumn column) { return ParkingOwnerOutputScore(column.Name, ownerSource.KeyColumn); })
                    .ThenBy(delegate(ParkingColumn column) { return column.Name; }, StringComparer.OrdinalIgnoreCase)
                    .Take(20);
                foreach (var column in ownerColumns)
                    parts.Add("o." + QuoteColumn(column.Name) + " AS " + QuoteColumn("Owner__" + column.Name));
            }

            // 车辆字段也按页面用途排序，避免旧库 Car_Issue 增加无关字段后再次挤掉关键值。
            var issueOutput = issueColumns
                .OrderByDescending(delegate(ParkingColumn column) { return ParkingVehicleOutputScore(column.Name); })
                .ThenBy(delegate(ParkingColumn column) { return column.Name; }, StringComparer.OrdinalIgnoreCase)
                .Take(25);
            foreach (var column in issueOutput)
                parts.Add("c." + QuoteColumn(column.Name));

            if (parts.Count == 0) throw new InvalidOperationException("Car_Issue 没有可返回的字段");
            return String.Join(", ", parts.ToArray());
        }

        private static int ParkingVehicleOutputScore(string column)
        {
            var normalized = NormalizeName(column);
            if (normalized == "pid" || normalized == "issueid" || normalized == "carid") return 200;
            if (normalized == "ownerid" || normalized == "userid") return 190;
            if (normalized == "pplate" || normalized == "plate" || normalized.Contains("plateno") ||
                normalized.Contains("carno") || normalized.Contains("carnumber") || normalized.Contains("license")) return 180;
            if (normalized == "peffective" || normalized == "pdownload") return 170;
            if (normalized == "pnote" || normalized.Contains("remark") || normalized.Contains("note") || normalized.Contains("备注")) return 160;
            if (normalized.Contains("carbeand") || normalized.Contains("carbrand") || normalized.Contains("identity") ||
                normalized.Contains("usertype") || normalized.Contains("carlei") || normalized.Contains("车辆") || normalized.Contains("性质")) return 150;
            if (normalized.Contains("enddate") || normalized.Contains("expire") || normalized.Contains("expiry") ||
                normalized.Contains("validto") || normalized.Contains("deadline") || normalized.Contains("overdate") || normalized.Contains("到期")) return 140;
            if (normalized.Contains("parkno") || normalized.Contains("parking") || normalized.Contains("space") ||
                normalized.Contains("berth") || normalized.Contains("garage") || normalized.Contains("车位") || normalized.Contains("地库")) return 130;
            if (normalized.Contains("start") || normalized.Contains("begin") || normalized.Contains("time") || normalized.Contains("date")) return 100;
            return 0;
        }

        private static int ParkingOwnerOutputScore(string column, string keyColumn)
        {
            var normalized = NormalizeName(column);
            if (String.Equals(normalized, NormalizeName(keyColumn), StringComparison.OrdinalIgnoreCase)) return 220;
            if (normalized == "ownername" || normalized.Contains("owneradd") || normalized.Contains("owneraddress") ||
                normalized.Contains("room") || normalized.Contains("house") || normalized.Contains("address") ||
                normalized.Contains("房号") || normalized.Contains("地址")) return 200;
            if (normalized.Contains("tel") || normalized.Contains("phone") || normalized.Contains("mobile") ||
                normalized.Contains("电话") || normalized.Contains("手机")) return 190;
            if (normalized.Contains("name") || normalized.Contains("姓名") || normalized.Contains("业主")) return 150;
            if (normalized.Contains("note") || normalized.Contains("remark") || normalized.Contains("备注")) return 120;
            return 0;
        }

        private static List<ParkingSearchRow> DeduplicateRows(List<ParkingSearchRow> rows)
        {
            var result = new List<ParkingSearchRow>();
            var byKey = new Dictionary<string, ParkingSearchRow>(StringComparer.OrdinalIgnoreCase);
            foreach (var row in rows)
            {
                var key = RowIdentity(row);
                ParkingSearchRow existing;
                if (!byKey.TryGetValue(key, out existing))
                {
                    byKey[key] = row;
                    result.Add(row);
                    continue;
                }

                foreach (var pair in row.fields)
                {
                    object current;
                    if (!existing.fields.TryGetValue(pair.Key, out current) ||
                        current == null || String.IsNullOrWhiteSpace(Convert.ToString(current, CultureInfo.InvariantCulture)))
                        existing.fields[pair.Key] = pair.Value;
                }
            }
            return result;
        }

        internal static List<ParkingSearchRow> DeduplicateRowsForTest(List<ParkingSearchRow> rows)
        {
            return DeduplicateRows(rows);
        }

        private static string RowIdentity(ParkingSearchRow row)
        {
            object value;
            if (TryField(row.fields, new[] { "p_id", "pid", "issue_id", "issueid", "car_id", "carid" }, out value) && value != null)
            {
                var id = Convert.ToString(value, CultureInfo.InvariantCulture);
                if (!String.IsNullOrWhiteSpace(id) && !Regex.IsMatch(id, "^0+$"))
                    return row.database + ":id:" + id.Trim();
            }

            var parts = new[] {
                FieldForIdentity(row.fields, new[] { "p_plate", "pplate", "plate", "carno", "carcode", "carnumber" }),
                FieldForIdentity(row.fields, new[] { "owner_id", "ownerid" }),
                FieldForIdentity(row.fields, new[] { "start_time", "starttime", "sart_time", "p_start" }),
                FieldForIdentity(row.fields, new[] { "end_time", "endtime", "enddate", "expiredate" }),
                FieldForIdentity(row.fields, new[] { "p_effective", "peffective" }),
                FieldForIdentity(row.fields, new[] { "p_download", "pdownload" }),
                FieldForIdentity(row.fields, new[] { "car_id", "carid", "card_id", "cardid" }),
            };
            return row.database + ":snapshot:" + String.Join("|", parts);
        }

        private static string FieldForIdentity(Dictionary<string, object> fields, string[] aliases)
        {
            object value;
            return TryField(fields, aliases, out value) && value != null
                ? Convert.ToString(value, CultureInfo.InvariantCulture).Trim().ToUpperInvariant()
                : "";
        }

        public static ParkingOwnerValues UpdateOwner(AgentConfig config, string password, ParkingOwnerUpdateTask task)
        {
            if (task == null) throw new InvalidOperationException("住户更新任务为空");
            Validate(config, password, task.database);
            if (!String.Equals(task.database, config.ParkingPhase1Database, StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(task.database, config.ParkingPhase2Database, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("任务指定的停车数据库不在本机配置中");
            if (String.IsNullOrWhiteSpace(task.externalOwnerId))
                throw new InvalidOperationException("旧停车系统住户编号为空");

            using (var connection = new SqlConnection(ConnectionString(config, password, task.database)))
            {
                connection.Open();
                var source = FindOwnerSource(connection);
                if (source == null) throw new InvalidOperationException(task.database + " 未识别到 Car_Issue.Owner_ID 关联的住户表");

                var hints = task.fieldHints ?? new ParkingOwnerFieldHints();
                var columns = new Dictionary<string, ParkingColumn>(StringComparer.OrdinalIgnoreCase)
                {
                    { "name", ResolveOwnerColumn(source.Columns, "name", hints.name) },
                    { "phone", ResolveOwnerColumn(source.Columns, "phone", hints.phone) },
                    { "room", ResolveOwnerColumn(source.Columns, "room", hints.room) },
                    // P_note 属于 Car_Issue，不是 P_Owner；住户基本资料和车辆备注是两张表。
                    { "note", null }
                };
                var issueColumns = LoadColumns(connection, "dbo", "Car_Issue");
                var issueNote = ResolveOwnerColumn(issueColumns, "note", hints.note);
                if (issueNote == null)
                    throw new InvalidOperationException(task.database + " 的 Car_Issue 表未识别到 P_note 备注列，已停止更新，防止丢失 PMS 操作来源");
                var plate = Clean(task.plate);
                if (String.IsNullOrWhiteSpace(plate))
                    throw new InvalidOperationException("住户资料更新缺少车牌，无法定位 Car_Issue.P_note");

                using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    var current = ReadOwner(connection, transaction, source, columns, task.externalOwnerId, true);
                    current.note = ReadIssueNote(connection, transaction, task.externalOwnerId, plate, issueNote, true);
                    var requested = task.values ?? new ParkingOwnerValues();
                    var desired = new ParkingOwnerValues
                    {
                        // 枫桦旧停车库的 P_Owner 没有姓名列；owner_Name 实际保存房号。
                        // 没有真实姓名列时忽略网页随 PMS 用户一并带来的姓名，绝不能写进房号。
                        name = columns["name"] == null ? null : Clean(requested.name),
                        phone = Clean(requested.phone),
                        room = Clean(requested.room),
                        note = AppendPmsSource(CleanMultiline(requested.note))
                    };
                    // 数据库已成功提交但首次回报遇到断网时，同一任务会再次领取。
                    // 读到目标值即按幂等成功返回，不能把已经完成的写入误报成并发冲突。
                    if (OwnerMatchesWithIssueNote(desired, current, columns, issueNote))
                    {
                        transaction.Commit();
                        return current;
                    }
                    AssertExpectedOwner(task.expected ?? new ParkingOwnerValues(), current, columns);
                    if (!String.Equals(CleanMultiline(GetOwnerValue((task.expected ?? new ParkingOwnerValues()), "note")), CleanMultiline(current.note), StringComparison.Ordinal))
                        throw new ParkingOwnerConflictException("旧系统的备注已被其他操作修改，请重新查询后再保存");

                    var assignments = new List<string>();
                    using (var update = connection.CreateCommand())
                    {
                        update.Transaction = transaction;
                        AddOwnerAssignment(update, assignments, columns["name"], "name", current.name, desired.name);
                        AddOwnerAssignment(update, assignments, columns["phone"], "phone", current.phone, desired.phone);
                        AddOwnerAssignment(update, assignments, columns["room"], "room", current.room, desired.room);
                        if (assignments.Count == 0)
                        {
                            if (String.Equals(CleanMultiline(current.note), CleanMultiline(desired.note), StringComparison.Ordinal))
                                throw new InvalidOperationException("住户资料没有发生变化");
                        }
                        if (assignments.Count > 0)
                        {
                            update.CommandText = "UPDATE " + QuoteName(source.Schema, source.Table) + " SET " +
                                String.Join(", ", assignments.ToArray()) + " WHERE CONVERT(NVARCHAR(200), " +
                                QuoteColumn(source.KeyColumn) + ") = @ownerId;";
                            update.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = task.externalOwnerId.Trim();
                            update.CommandTimeout = 15;
                            var affected = update.ExecuteNonQuery();
                            if (affected != 1) throw new InvalidOperationException("住户更新影响了 " + affected + " 条记录，已回滚");
                        }
                        if (!String.Equals(CleanMultiline(current.note), CleanMultiline(desired.note), StringComparison.Ordinal))
                            UpdateIssueNote(connection, transaction, task.externalOwnerId, plate, issueNote, current.note, desired.note);
                    }

                    var result = ReadOwner(connection, transaction, source, columns, task.externalOwnerId, false);
                    result.note = ReadIssueNote(connection, transaction, task.externalOwnerId, plate, issueNote, false);
                    AssertOwnerWrittenWithIssueNote(desired, result, columns, issueNote);
                    transaction.Commit();
                    return result;
                }
            }
        }

        /** 执行网页提交的停车业务。续期及车辆结构性变化均调用旧系统存储过程。 */
        public static Dictionary<string, object> ExecuteOperation(AgentConfig config, string password, ParkingOperationTask task)
        {
            if (task == null || String.IsNullOrWhiteSpace(task.kind)) throw new InvalidOperationException("停车操作任务为空");
            Validate(config, password, task.database);
            var payload = task.payload ?? new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            var plate = Value(payload, "plate");
            var newPlate = Value(payload, "newPlate");
            var admin = Value(payload, "admin") ?? "PMS";
            if (task.kind == "sync_vehicle_info")
                return SyncVehicleInfo(config, password, task, payload, plate);
            using (var connection = new SqlConnection(ConnectionString(config, password, task.database)))
            {
                connection.Open();
                if (task.kind == "add_vehicle")
                {
                    var effective = Value(payload, "effective") ?? ZeroBits();
                    var download = Value(payload, "download") ?? ZeroBits();
                    using (var command = Procedure(connection, "AddIssue"))
                    {
                        Add(command, "@owner_Name", SqlDbType.VarChar, 20, LegacyOwnerRoom(payload));
                        Add(command, "@owner_Add", SqlDbType.VarChar, 80, Value(payload, "ownerAddress") ?? "");
                        Add(command, "@owner_Tel", SqlDbType.VarChar, 80, Value(payload, "ownerPhone") ?? "");
                        Add(command, "@owner_Sex", SqlDbType.Int, 0, Number(payload, "ownerSex", 0));
                        Add(command, "@owner_depa", SqlDbType.VarChar, 50, Value(payload, "ownerDepartment") ?? "PMS");
                        Add(command, "@Owner_Image", SqlDbType.VarChar, 80, Value(payload, "ownerImage") ?? "");
                        Add(command, "@P_plate", SqlDbType.VarChar, 50, plate);
                        Add(command, "@P_Color", SqlDbType.VarChar, 10, Value(payload, "color") ?? "蓝");
                        Add(command, "@Car_Lei", SqlDbType.Int, 0, Number(payload, "carType", 1));
                        Add(command, "@Sart_Time", SqlDbType.DateTime, 0, DateValue(payload, "startDate", DateTime.Today));
                        Add(command, "@End_Time", SqlDbType.DateTime, 0, DateValue(payload, "endDate", DateTime.Today));
                        Add(command, "@Car_ID", SqlDbType.VarChar, 20, Value(payload, "carId") ?? "0000000000");
                        Add(command, "@Car_Brand", SqlDbType.VarChar, 20, Value(payload, "identity") ?? "住户车");
                        Add(command, "@Car_Money", SqlDbType.Float, 0, NumberDecimal(payload, "amount", 0));
                        Add(command, "@Car_Deposit", SqlDbType.Float, 0, NumberDecimal(payload, "deposit", 0));
                        Add(command, "@Car_Zt", SqlDbType.Int, 0, Number(payload, "state", 1));
                        Add(command, "@P_note", SqlDbType.VarChar, 200, Value(payload, "note") ?? "操作来源：PMS系统");
                        Add(command, "@P_Admin", SqlDbType.VarChar, 20, admin);
                        Add(command, "@P_Spaces", SqlDbType.VarChar, 20, Value(payload, "spaces") ?? "");
                        Add(command, "@P_Effective", SqlDbType.VarChar, 256, effective);
                        Add(command, "@P_Download", SqlDbType.VarChar, 256, download);
                        command.ExecuteNonQuery();
                    }
                    return VerifyVehicle(connection, plate, "新增车牌");
                }
                if (task.kind == "renew_vehicle")
                {
                    // Palte_extend 会把续期流水写入旧库 P_moneyKeep（“最近的充值延期车辆”）。
                    // 该表的操作员必须使用旧库中预先建立的 PMS 账号，不能接受网页随意传入的名称。
                    const string renewalOperator = "PMS";
                    var renewalType = Number(payload, "feeType", 5);
                    using (var command = Procedure(connection, "Palte_extend"))
                    {
                        Add(command, "@P_plate", SqlDbType.VarChar, 50, plate);
                        Add(command, "@type", SqlDbType.Int, 0, renewalType);
                        Add(command, "@P_money", SqlDbType.Float, 0, NumberDecimal(payload, "amount", 0));
                        Add(command, "@End_Time", SqlDbType.DateTime, 0, DateValue(payload, "endDate", DateTime.Today));
                        Add(command, "@P_Admin", SqlDbType.VarChar, 20, renewalOperator);
                        command.ExecuteNonQuery();
                    }
                    var result = VerifyVehicle(connection, plate, "续期车牌");
                    var audit = VerifyRenewalAudit(connection, plate, renewalOperator, renewalType, Convert.ToInt32(result["issueId"], CultureInfo.InvariantCulture));
                    if (audit == null)
                        throw new InvalidOperationException("续期已更新车辆，但未在旧库最近的充值延期车辆中读到 PMS 操作记录");
                    result["legacyOperator"] = renewalOperator;
                    result["legacyAuditTable"] = "P_moneyKeep";
                    result["legacyAuditId"] = audit["id"];
                    result["legacyAuditType"] = renewalType;
                    result["legacyAuditVerified"] = true;
                    return result;
                }
                if (task.kind == "rebind_owner") return RebindParkingOwner(connection, task, payload);
                if (task.kind == "update_garages") return UpdateGarageAuthorizations(config, password, task, payload, plate, admin);
                if (task.kind == "update_vehicle_type") return UpdateVehicleType(connection, task, payload, plate, admin);
                if (task.kind == "change_plate")
                {
                    var targetPlate = task.kind == "change_plate" ? newPlate : plate;
                    using (var command = Procedure(connection, "Up_PakIssue"))
                    {
                        Add(command, "@Pak_plate", SqlDbType.VarChar, 50, targetPlate);
                        Add(command, "@y_Pak_plate", SqlDbType.VarChar, 50, plate);
                        Add(command, "@P_Color", SqlDbType.VarChar, 10, Value(payload, "color") ?? "蓝");
                        Add(command, "@Car_Lei", SqlDbType.Int, 0, Number(payload, "carType", 1));
                        Add(command, "@owner_Name", SqlDbType.VarChar, 20, LegacyOwnerRoom(payload));
                        Add(command, "@Car_Brand", SqlDbType.VarChar, 20, Value(payload, "identity") ?? "住户车");
                        Add(command, "@P_note", SqlDbType.VarChar, 200, Value(payload, "note") ?? "操作来源：PMS系统");
                        Add(command, "@admin", SqlDbType.VarChar, 20, admin);
                        Add(command, "@P_Spaces", SqlDbType.VarChar, 20, Value(payload, "spaces") ?? "");
                        Add(command, "@P_Effective", SqlDbType.VarChar, 256, Value(payload, "effective") ?? ZeroBits());
                        Add(command, "@P_Download", SqlDbType.VarChar, 256, Value(payload, "download") ?? ZeroBits());
                        command.ExecuteNonQuery();
                    }
                    return VerifyVehicle(connection, targetPlate, "变更车牌");
                }
                if (task.kind == "delete_vehicle")
                {
                    using (var command = Procedure(connection, "Add_Del_Plate"))
                    {
                        Add(command, "@P_plate", SqlDbType.VarChar, 50, plate);
                        Add(command, "@Up_moey", SqlDbType.Int, 0, Number(payload, "refund", 0));
                        Add(command, "@Up_Yajin", SqlDbType.Int, 0, Number(payload, "depositRefund", 0));
                        Add(command, "@Admin", SqlDbType.VarChar, 20, admin);
                        command.ExecuteNonQuery();
                    }
                    using (var check = connection.CreateCommand())
                    {
                        check.CommandText = "SELECT COUNT(*) FROM Car_Issue WHERE P_plate=@plate";
                        Add(check, "@plate", SqlDbType.VarChar, 50, plate);
                        var count = Convert.ToInt32(check.ExecuteScalar());
                        if (count != 0) throw new InvalidOperationException("注销存储过程执行后旧库仍存在该车牌");
                        return new Dictionary<string, object> { { "verified", true }, { "remaining", count } };
                    }
                }
                if (task.kind == "download_vehicle")
                {
                    ExecuteDownloadVehicle(connection, payload, plate, admin);
                    return VerifyDownloadQueue(connection, plate);
                }
                throw new InvalidOperationException("不支持的停车操作：" + task.kind);
            }
        }

        private sealed class ParkingVehicleSyncSnapshot
        {
            public string IssueId { get; set; }
            public string Plate { get; set; }
            public string OwnerId { get; set; }
            public string Room { get; set; }
            public DateTime? EndDate { get; set; }
            public string Note { get; set; }
        }

        /**
         * 一期、二期同车牌资料对齐：源库只读锁定，目标库串行化写入。
         * 只复用房号和备注；到期日属于各库续期业务，不在资料复用中修改。
         * 每个 UPDATE 都带原值条件并在同一事务内回读，不允许宽泛按车牌改多条数据。
         */
        private static Dictionary<string, object> SyncVehicleInfo(AgentConfig config, string password,
            ParkingOperationTask task, Dictionary<string, object> payload, string plate)
        {
            var sourceDatabase = Clean(Value(payload, "sourceDatabase"));
            var sourceRecordId = Clean(Value(payload, "sourceRecordId"));
            var targetRecordId = Clean(task.sourceRecordId);
            var sourcePlate = Clean(Value(payload, "sourcePlate")) ?? Clean(plate);
            var targetPlate = Clean(Value(payload, "targetPlate")) ?? Clean(plate);
            if (sourceDatabase == null || sourceRecordId == null || targetRecordId == null || sourcePlate == null || targetPlate == null)
                throw new InvalidOperationException("车辆资料同步缺少源库、源记录、目标记录或车牌");
            if (!String.Equals(NormalizePlate(sourcePlate), NormalizePlate(targetPlate), StringComparison.Ordinal))
                throw new InvalidOperationException("只能同步一期、二期中的同一车牌");
            EnsureConfiguredParkingDatabase(config, sourceDatabase);
            EnsureConfiguredParkingDatabase(config, task.database);
            if (String.Equals(sourceDatabase, task.database, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("源停车库和目标停车库不能相同");

            using (var sourceConnection = new SqlConnection(ConnectionString(config, password, sourceDatabase)))
            using (var targetConnection = new SqlConnection(ConnectionString(config, password, task.database)))
            {
                sourceConnection.Open();
                targetConnection.Open();
                var sourceOwner = FindOwnerSource(sourceConnection);
                var targetOwner = FindOwnerSource(targetConnection);
                if (sourceOwner == null || targetOwner == null)
                    throw new InvalidOperationException("一期或二期停车库未识别到 P_Owner 住户表");
                var sourceRoomColumn = ResolveOwnerColumn(sourceOwner.Columns, "room", null);
                var targetRoomColumn = ResolveOwnerColumn(targetOwner.Columns, "room", null);
                var sourceNoteColumn = ResolveOwnerColumn(LoadColumns(sourceConnection, "dbo", "Car_Issue"), "note", "P_note");
                var targetNoteColumn = ResolveOwnerColumn(LoadColumns(targetConnection, "dbo", "Car_Issue"), "note", "P_note");
                if (sourceRoomColumn == null || targetRoomColumn == null || sourceNoteColumn == null || targetNoteColumn == null)
                    throw new InvalidOperationException("一期或二期停车库缺少 owner_Name/P_note 必要字段，已停止同步");

                using (var sourceTransaction = sourceConnection.BeginTransaction(IsolationLevel.Serializable))
                using (var targetTransaction = targetConnection.BeginTransaction(IsolationLevel.Serializable))
                {
                    var source = ReadVehicleSyncSnapshot(sourceConnection, sourceTransaction, sourceOwner,
                        sourceRoomColumn, sourceNoteColumn, sourceRecordId, sourcePlate, true);
                    var target = ReadVehicleSyncSnapshot(targetConnection, targetTransaction, targetOwner,
                        targetRoomColumn, targetNoteColumn, targetRecordId, targetPlate, true);
                    if (source.Room == null)
                        throw new InvalidOperationException("源停车库房号为空，不会清空目标库房号");
                    var desiredRoom = ResolveAvailableOwnerRoom(targetConnection, targetTransaction, targetOwner,
                        targetRoomColumn, target.OwnerId, source.Room);
                    if (VehicleSyncMatches(target, source, desiredRoom))
                    {
                        var already = VehicleSyncResult(sourceDatabase, task.database, target, target,
                            !String.Equals(source.Room, desiredRoom, StringComparison.Ordinal), true);
                        targetTransaction.Commit();
                        sourceTransaction.Commit();
                        return already;
                    }
                    AssertExpectedVehicleSync(task.expected, target);

                    if (!String.Equals(Clean(target.Room), Clean(desiredRoom), StringComparison.Ordinal))
                        UpdateOwnerRoomForSync(targetConnection, targetTransaction, targetOwner, targetRoomColumn,
                            target.OwnerId, target.Room, desiredRoom);
                    if (!String.Equals(CleanMultiline(target.Note), CleanMultiline(source.Note), StringComparison.Ordinal))
                        UpdateIssueNoteForSync(targetConnection, targetTransaction, targetNoteColumn,
                            target.IssueId, targetPlate, target.Note, source.Note);

                    var written = ReadVehicleSyncSnapshot(targetConnection, targetTransaction, targetOwner,
                        targetRoomColumn, targetNoteColumn, targetRecordId, targetPlate, false);
                    AssertVehicleSyncWritten(source, desiredRoom, written);
                    var result = VehicleSyncResult(sourceDatabase, task.database, target, written,
                        !String.Equals(source.Room, desiredRoom, StringComparison.Ordinal), false);
                    targetTransaction.Commit();
                    sourceTransaction.Commit();
                    return result;
                }
            }
        }

        private static ParkingVehicleSyncSnapshot ReadVehicleSyncSnapshot(SqlConnection connection,
            SqlTransaction transaction, ParkingOwnerSource ownerSource, ParkingColumn roomColumn,
            ParkingColumn noteColumn, string issueId, string plate, bool lockRow)
        {
            string ownerId;
            DateTime? endDate;
            string note;
            string actualIssueId;
            string actualPlate;
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT TOP 2 [P_id], [P_plate], [Owner_ID], [End_Time], " +
                    QuoteColumn(noteColumn.Name) + " FROM [dbo].[Car_Issue]" +
                    (lockRow ? " WITH (UPDLOCK, HOLDLOCK)" : "") +
                    " WHERE CONVERT(NVARCHAR(100), [P_id])=@issueId AND CONVERT(NVARCHAR(100), [P_plate])=@plate;";
                command.Parameters.Add("@issueId", SqlDbType.NVarChar, 100).Value = issueId;
                command.Parameters.Add("@plate", SqlDbType.NVarChar, 100).Value = plate;
                command.CommandTimeout = 15;
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read()) throw new InvalidOperationException("停车库中找不到指定记录 #" + issueId + " 车牌 " + plate);
                    ownerId = reader["Owner_ID"] == DBNull.Value ? null : Convert.ToString(reader["Owner_ID"], CultureInfo.InvariantCulture);
                    endDate = reader["End_Time"] == DBNull.Value ? (DateTime?)null : Convert.ToDateTime(reader["End_Time"], CultureInfo.InvariantCulture);
                    note = reader[noteColumn.Name] == DBNull.Value ? null : Convert.ToString(reader[noteColumn.Name]);
                    actualIssueId = Convert.ToString(reader["P_id"], CultureInfo.InvariantCulture);
                    actualPlate = Convert.ToString(reader["P_plate"]);
                    if (reader.Read()) throw new InvalidOperationException("指定停车记录 #" + issueId + " 对应多条数据，已停止同步");
                }
            }
            if (String.IsNullOrWhiteSpace(ownerId)) throw new InvalidOperationException("停车记录 #" + issueId + " 没有绑定住户");
            var columns = new Dictionary<string, ParkingColumn>(StringComparer.OrdinalIgnoreCase)
            {
                { "name", null }, { "phone", null }, { "room", roomColumn }, { "note", null }
            };
            var owner = ReadOwner(connection, transaction, ownerSource, columns, ownerId, lockRow);
            return new ParkingVehicleSyncSnapshot
            {
                IssueId = actualIssueId,
                Plate = actualPlate,
                OwnerId = ownerId,
                Room = owner.room,
                EndDate = endDate,
                Note = note
            };
        }

        private static void AssertExpectedVehicleSync(Dictionary<string, object> expected, ParkingVehicleSyncSnapshot target)
        {
            expected = expected ?? new Dictionary<string, object>();
            var expectedRoom = Clean(Value(expected, "room"));
            var expectedNote = CleanMultiline(Value(expected, "note"));
            if (!String.Equals(expectedRoom, Clean(target.Room), StringComparison.Ordinal))
                throw new InvalidOperationException("目标库房号已被其他操作修改，请重新查询后再同步");
            if (!String.Equals(expectedNote, CleanMultiline(target.Note), StringComparison.Ordinal))
                throw new InvalidOperationException("目标库备注已被其他操作修改，请重新查询后再同步");
        }

        private static string ResolveAvailableOwnerRoom(SqlConnection connection, SqlTransaction transaction,
            ParkingOwnerSource source, ParkingColumn roomColumn, string ownerId, string requestedRoom)
        {
            requestedRoom = Clean(requestedRoom);
            if (requestedRoom == null) throw new InvalidOperationException("源停车库房号为空");
            for (var suffix = 1; suffix <= 999; suffix++)
            {
                var candidate = suffix == 1 ? requestedRoom : requestedRoom + "/" + suffix.ToString(CultureInfo.InvariantCulture);
                if (roomColumn.CharacterLimit > 0 && candidate.Length > roomColumn.CharacterLimit)
                    throw new InvalidOperationException("房号“" + requestedRoom + "”遇到重名，但加自增后缀后超过旧库 " + roomColumn.CharacterLimit + " 字限制");
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "SELECT COUNT_BIG(1) FROM " + QuoteName(source.Schema, source.Table) +
                        " WITH (UPDLOCK, HOLDLOCK) WHERE CONVERT(NVARCHAR(4000), " + QuoteColumn(roomColumn.Name) +
                        ")=@room AND CONVERT(NVARCHAR(200), " + QuoteColumn(source.KeyColumn) + ")<>@ownerId;";
                    command.Parameters.Add("@room", SqlDbType.NVarChar, Math.Max(1, roomColumn.CharacterLimit > 0 ? roomColumn.CharacterLimit : 4000)).Value = candidate;
                    command.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = ownerId;
                    command.CommandTimeout = 15;
                    if (Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture) == 0) return candidate;
                }
            }
            throw new InvalidOperationException("房号“" + requestedRoom + "”重名过多，已停止同步");
        }

        internal static string ResolveAvailableOwnerRoomForTest(string requestedRoom, int characterLimit, params string[] occupied)
        {
            requestedRoom = Clean(requestedRoom);
            var used = new HashSet<string>(occupied ?? new string[0], StringComparer.Ordinal);
            for (var suffix = 1; suffix <= 999; suffix++)
            {
                var candidate = suffix == 1 ? requestedRoom : requestedRoom + "/" + suffix.ToString(CultureInfo.InvariantCulture);
                if (characterLimit > 0 && candidate.Length > characterLimit) throw new InvalidOperationException("房号加后缀后超长");
                if (!used.Contains(candidate)) return candidate;
            }
            throw new InvalidOperationException("房号重名过多");
        }

        private static void UpdateOwnerRoomForSync(SqlConnection connection, SqlTransaction transaction,
            ParkingOwnerSource source, ParkingColumn roomColumn, string ownerId, string before, string after)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "UPDATE " + QuoteName(source.Schema, source.Table) + " SET " +
                    QuoteColumn(roomColumn.Name) + "=@after WHERE CONVERT(NVARCHAR(200), " + QuoteColumn(source.KeyColumn) +
                    ")=@ownerId AND ISNULL(CONVERT(NVARCHAR(4000), " + QuoteColumn(roomColumn.Name) + "), N'')=@before;";
                command.Parameters.Add("@after", SqlDbType.NVarChar, Math.Max(1, roomColumn.CharacterLimit > 0 ? roomColumn.CharacterLimit : 4000)).Value = after;
                command.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = ownerId;
                command.Parameters.Add("@before", SqlDbType.NVarChar, 4000).Value = before ?? "";
                command.CommandTimeout = 15;
                if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("目标库房号已被其他操作修改，本次同步已回滚");
            }
        }

        private static void UpdateIssueNoteForSync(SqlConnection connection, SqlTransaction transaction,
            ParkingColumn noteColumn, string issueId, string plate, string before, string after)
        {
            if (after != null && noteColumn.CharacterLimit > 0 && after.Length > noteColumn.CharacterLimit)
                throw new InvalidOperationException("源库备注超过目标库 " + noteColumn.CharacterLimit + " 字限制");
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "UPDATE [dbo].[Car_Issue] SET " + QuoteColumn(noteColumn.Name) +
                    "=@after WHERE CONVERT(NVARCHAR(100), [P_id])=@issueId AND CONVERT(NVARCHAR(100), [P_plate])=@plate" +
                    " AND ISNULL(CONVERT(NVARCHAR(4000), " + QuoteColumn(noteColumn.Name) + "), N'')=@before;";
                command.Parameters.Add("@after", SqlDbType.NVarChar, Math.Max(1, noteColumn.CharacterLimit > 0 ? noteColumn.CharacterLimit : 4000)).Value =
                    after == null ? (object)DBNull.Value : after;
                command.Parameters.Add("@issueId", SqlDbType.NVarChar, 100).Value = issueId;
                command.Parameters.Add("@plate", SqlDbType.NVarChar, 100).Value = plate;
                command.Parameters.Add("@before", SqlDbType.NVarChar, 4000).Value = before ?? "";
                command.CommandTimeout = 15;
                if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("目标库备注已被其他操作修改，本次同步已回滚");
            }
        }

        private static void AssertUniqueVehiclePlate(SqlConnection connection, SqlTransaction transaction,
            string issueId, string plate)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT COUNT_BIG(1) FROM [dbo].[Car_Issue] WITH (UPDLOCK, HOLDLOCK)" +
                    " WHERE CONVERT(NVARCHAR(100), [P_plate])=@plate;";
                command.Parameters.Add("@plate", SqlDbType.NVarChar, 100).Value = plate;
                command.CommandTimeout = 15;
                var count = Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
                if (count != 1) throw new InvalidOperationException("目标库车牌 " + plate + " 存在 " + count + " 条记录，Palte_extend 无法精确定位单条，已停止同步");
            }
        }

        private static bool VehicleSyncMatches(ParkingVehicleSyncSnapshot target,
            ParkingVehicleSyncSnapshot source, string desiredRoom)
        {
            var sameRoom = String.Equals(Clean(target.Room), Clean(desiredRoom), StringComparison.Ordinal) ||
                String.Equals(NormalizeRoomIdentity(target.Room), NormalizeRoomIdentity(source.Room), StringComparison.Ordinal);
            return sameRoom && String.Equals(CleanMultiline(target.Note), CleanMultiline(source.Note), StringComparison.Ordinal);
        }

        private static void AssertVehicleSyncWritten(ParkingVehicleSyncSnapshot source, string desiredRoom,
            ParkingVehicleSyncSnapshot written)
        {
            if (!String.Equals(Clean(desiredRoom), Clean(written.Room), StringComparison.Ordinal))
                throw new InvalidOperationException("房号写入后读回不一致，本次同步已回滚");
            if (!String.Equals(CleanMultiline(source.Note), CleanMultiline(written.Note), StringComparison.Ordinal))
                throw new InvalidOperationException("备注写入后读回不一致，本次同步已回滚");
        }

        private static Dictionary<string, object> VehicleSyncResult(string sourceDatabase, string targetDatabase,
            ParkingVehicleSyncSnapshot before, ParkingVehicleSyncSnapshot after, bool roomConflictAdjusted, bool alreadySynced)
        {
            return new Dictionary<string, object>
            {
                { "verified", true }, { "alreadySynced", alreadySynced },
                { "sourceDatabase", sourceDatabase }, { "targetDatabase", targetDatabase },
                { "plate", after.Plate }, { "targetOwnerId", after.OwnerId },
                { "beforeRoom", before.Room }, { "afterRoom", after.Room },
                { "beforeNote", before.Note }, { "afterNote", after.Note },
                { "roomConflictAdjusted", roomConflictAdjusted }
            };
        }

        private static bool SameDate(DateTime? left, DateTime? right)
        {
            return left.HasValue == right.HasValue && (!left.HasValue || left.Value.Date == right.Value.Date);
        }

        private static string DateText(DateTime? value)
        {
            return value.HasValue ? value.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
        }

        private static string NormalizeRoomIdentity(string value)
        {
            value = Clean(value);
            if (value == null) return null;
            var parts = value.Replace('\\', '/').Replace('-', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(delegate(string item) { return item.Trim(); }).ToArray();
            if (parts.Length >= 4 && parts.All(delegate(string item) { int number; return Int32.TryParse(item, out number); }))
                return String.Join("/", parts.Take(3).ToArray());
            return String.Join("/", parts);
        }

        private static string NormalizePlate(string value)
        {
            return (value ?? "").Replace(" ", "").Replace("·", "").Trim().ToUpperInvariant();
        }

        private static void EnsureConfiguredParkingDatabase(AgentConfig config, string database)
        {
            if (!String.Equals(database, config.ParkingPhase1Database, StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(database, config.ParkingPhase2Database, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("任务指定的停车数据库不在本机配置中：" + database);
        }

        internal static string CanonicalBindingRoom(string room)
        {
            var match = Regex.Match((room ?? "").Trim(), @"^(198|228)[/-](\d{1,2})[/-](\d{2,4})(?:/\d+)?$");
            if (!match.Success || Int32.Parse(match.Groups[2].Value) <= 0 || Int32.Parse(match.Groups[3].Value) <= 0)
                throw new InvalidOperationException("绑定房号必须来自 PMS 房产，例如 198/8/102");
            return match.Groups[1].Value + "/" + Int32.Parse(match.Groups[2].Value) + "/" + Int32.Parse(match.Groups[3].Value);
        }

        internal static string NextBindingRoom(string room, IEnumerable<string> existing)
        {
            var canonical = CanonicalBindingRoom(room);
            var used = new HashSet<string>(existing.Select(delegate(string name) { return (name ?? "").Trim(); }), StringComparer.OrdinalIgnoreCase);
            if (!used.Contains(canonical)) return canonical;
            var highest = 1;
            foreach (var name in used)
            {
                if (!name.StartsWith(canonical + "/", StringComparison.OrdinalIgnoreCase)) continue;
                int suffix;
                if (Int32.TryParse(name.Substring(canonical.Length + 1), out suffix)) highest = Math.Max(highest, suffix);
            }
            if (highest == Int32.MaxValue) throw new InvalidOperationException("房号编号超出范围，已停止写入");
            var result = canonical + "/" + (highest + 1).ToString(CultureInfo.InvariantCulture);
            if (result.Length > 20) throw new InvalidOperationException("旧停车系统房号超过 20 字符，已停止写入");
            return result;
        }

        // 仅住户建档插入 P_Owner；车辆关联仍由原 Up_PakIssue 维护。整个动作失败即回滚。
        private static Dictionary<string, object> RebindParkingOwner(SqlConnection connection, ParkingOperationTask task, Dictionary<string, object> payload)
        {
            if (Number(payload, "bindingContract", 0) != 1) throw new InvalidOperationException("旧版变更绑定任务缺少 PMS 房号，请重新选择房号提交");
            var plate = Value(payload, "plate");
            var room = CanonicalBindingRoom(Value(payload, "ownerRoom"));
            var phone = Value(payload, "ownerPhone") ?? "";
            if (phone.Length > 80) throw new InvalidOperationException("业主电话超过旧停车系统 80 字符上限");
            using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
            {
                // 旧软件也可能并发建档；表锁保护编号分配+插入，不能先查后在另一个事务中插入。
                var existing = new List<string>();
                using (var names = connection.CreateCommand())
                {
                    names.Transaction = transaction;
                    names.CommandText = "SELECT owner_Name FROM dbo.P_Owner WITH (TABLOCKX,HOLDLOCK) WHERE owner_Name=@room OR owner_Name LIKE @prefix";
                    Add(names, "@room", SqlDbType.VarChar, 20, room);
                    Add(names, "@prefix", SqlDbType.VarChar, 24, room + "/%");
                    using (var reader = names.ExecuteReader()) while (reader.Read()) existing.Add(Convert.ToString(reader[0]));
                }
                var before = ReadBindingVehicle(connection, transaction, plate);
                if (!String.IsNullOrEmpty(task.sourceRecordId) && task.sourceRecordId != Value(before, "P_id"))
                    throw new InvalidOperationException("车牌的车辆记录已变化，请重新查询再绑定");
                var oldId = Value(before, "Owner_ID");
                var oldOwner = ReadBindingOwner(connection, transaction, oldId);
                var expectedId = Value(payload, "previousOwnerId");
                var restoreId = Value(payload, "restoreOwnerId");
                var marker = "PMS绑定:" + task.taskId.ToString(CultureInfo.InvariantCulture);
                // 只有本任务的专属建档标记才允许作为丢失回执后的幂等重放依据。
                if ((Value(oldOwner, "owner_depa") == marker || (!String.IsNullOrEmpty(restoreId) && oldId == restoreId)) && CanonicalBindingRoom(Value(oldOwner, "owner_Name")) == room &&
                    (Value(oldOwner, "owner_Tel") ?? "") == phone)
                {
                    var original = ReadBindingOwner(connection, transaction, expectedId);
                    transaction.Commit();
                    return BindingResult(before, original, oldOwner, expectedId, oldId);
                }
                if (String.IsNullOrEmpty(expectedId) || oldId != expectedId)
                    throw new InvalidOperationException("车辆绑定住户已改变，请重新查询后提交；没有修改旧库");
                var targetId = restoreId;
                Dictionary<string, object> target;
                if (!String.IsNullOrEmpty(restoreId))
                {
                    target = ReadBindingOwner(connection, transaction, restoreId);
                    if (CanonicalBindingRoom(Value(target, "owner_Name")) != room || (Value(target, "owner_Tel") ?? "") != phone)
                        throw new InvalidOperationException("原住户资料已变化，不能自动恢复，请重新选择房号");
                }
                else
                {
                    var targetRoom = NextBindingRoom(room, existing);
                    using (var insert = connection.CreateCommand())
                    {
                        insert.Transaction = transaction;
                        insert.CommandText = @"
DECLARE @created TABLE (id NVARCHAR(30));
IF COLUMNPROPERTY(OBJECT_ID(N'dbo.P_Owner'), 'UserID', 'IsIdentity') = 1
 INSERT INTO dbo.P_Owner(owner_Name,owner_Add,owner_Tel,owner_Sex,owner_depa,Owner_Image)
 OUTPUT INSERTED.UserID INTO @created VALUES(@room,@address,@phone,0,@marker,'');
ELSE
 INSERT INTO dbo.P_Owner(UserID,owner_Name,owner_Add,owner_Tel,owner_Sex,owner_depa,Owner_Image)
 OUTPUT INSERTED.UserID INTO @created SELECT ISNULL(MAX(CONVERT(BIGINT,UserID)),0)+1,@room,@address,@phone,0,@marker,'' FROM dbo.P_Owner;
SELECT id FROM @created;";
                        Add(insert, "@room", SqlDbType.VarChar, 20, targetRoom);
                        Add(insert, "@address", SqlDbType.VarChar, 80, room);
                        Add(insert, "@phone", SqlDbType.VarChar, 80, phone);
                        Add(insert, "@marker", SqlDbType.VarChar, 50, marker);
                        targetId = Convert.ToString(insert.ExecuteScalar(), CultureInfo.InvariantCulture);
                    }
                    target = ReadBindingOwner(connection, transaction, targetId);
                    if (Value(target, "owner_Name") != targetRoom || (Value(target, "owner_Tel") ?? "") != phone)
                        throw new InvalidOperationException("旧库住户建档读回不一致，已撤销本次操作");
                }
                using (var command = Procedure(connection, "Up_PakIssue"))
                {
                    command.Transaction = transaction;
                    AddBindingProcedureParameters(command, before, Value(target, "owner_Name"));
                    command.ExecuteNonQuery();
                }
                var after = ReadBindingVehicle(connection, transaction, plate);
                if (Value(after, "Owner_ID") != targetId) throw new InvalidOperationException("Up_PakIssue 未绑定到所选住户，已撤销本次操作");
                foreach (var key in new[] { "P_id", "P_plate", "End_Time", "Sart_Time", "Car_Money", "Car_Deposit", "Car_Zt", "Car_ID", "P_Color", "Car_Lei", "Car_Beand", "Car_Brand", "P_note", "P_Spaces", "P_Effective", "P_Download" })
                {
                    if (Value(before, key) != Value(after, key)) throw new InvalidOperationException("绑定过程意外改变车辆字段 " + key + "，已撤销本次操作");
                }
                transaction.Commit();
                return BindingResult(after, oldOwner, target, oldId, targetId);
            }
        }

        internal static void AddBindingProcedureParameters(SqlCommand command, Dictionary<string, object> current, string targetRoom)
        {
            Add(command, "@Pak_plate", SqlDbType.VarChar, 50, current["P_plate"]);
            Add(command, "@y_Pak_plate", SqlDbType.VarChar, 50, current["P_plate"]);
            Add(command, "@P_Color", SqlDbType.VarChar, 10, current["P_Color"]);
            Add(command, "@Car_Lei", SqlDbType.Int, 0, current["Car_Lei"]);
            Add(command, "@owner_Name", SqlDbType.VarChar, 20, targetRoom);
            Add(command, "@Car_Brand", SqlDbType.VarChar, 20, Value(current, "Car_Beand") ?? Value(current, "Car_Brand"));
            Add(command, "@P_note", SqlDbType.VarChar, 200, current["P_note"]);
            Add(command, "@admin", SqlDbType.VarChar, 20, "PMS");
            Add(command, "@P_Spaces", SqlDbType.VarChar, 20, current["P_Spaces"]);
            Add(command, "@P_Effective", SqlDbType.VarChar, 256, current["P_Effective"]);
            Add(command, "@P_Download", SqlDbType.VarChar, 256, current["P_Download"]);
        }

        private static Dictionary<string, object> UpdateVehicleType(SqlConnection connection, ParkingOperationTask task,
            Dictionary<string, object> payload, string plate, string admin)
        {
            var identity = Clean(Value(payload, "identity"));
            if (identity == null) throw new InvalidOperationException("车辆授权类型不能为空");
            using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
            {
                var before = ReadBindingVehicle(connection, transaction, plate);
                using (var command = Procedure(connection, transaction, "Up_PakIssue"))
                {
                    AddBindingProcedureParameters(command, before, LegacyOwnerRoom(payload));
                    command.Parameters["@Car_Brand"].Value = identity;
                    command.Parameters["@admin"].Value = admin;
                    command.ExecuteNonQuery();
                }
                var after = ReadBindingVehicle(connection, transaction, plate);
                var afterIdentity = Value(after, "Car_Beand") ?? Value(after, "Car_Brand");
                if (!String.Equals(afterIdentity, identity, StringComparison.Ordinal))
                    throw new InvalidOperationException("车辆授权类型写入后读回不一致，已撤销本次操作");
                transaction.Commit();
                return new Dictionary<string, object> {
                    { "verified", true }, { "plate", Value(after, "P_plate") }, { "issueId", Value(after, "P_id") },
                    { "previousIdentity", Value(before, "Car_Beand") ?? Value(before, "Car_Brand") },
                    { "identity", afterIdentity }
                };
            }
        }

        private static Dictionary<string, object> UpdateGarageAuthorizations(AgentConfig config, string password, ParkingOperationTask task,
            Dictionary<string, object> payload, string plate, string admin)
        {
            var requested = RequestedGarageKeys(payload);
            var results = new List<Dictionary<string, object>>();
            Dictionary<string, object> source = null;
            using (var sourceConnection = new SqlConnection(ConnectionString(config, password, task.database)))
            {
                sourceConnection.Open();
                using (var sourceTransaction = sourceConnection.BeginTransaction(IsolationLevel.Serializable))
                {
                    source = ReadBindingVehicle(sourceConnection, sourceTransaction, plate);
                    sourceTransaction.Commit();
                }
            }
            foreach (var database in new[] { "parking1", "parking2" })
            {
                Validate(config, password, database);
                using (var connection = new SqlConnection(ConnectionString(config, password, database)))
                {
                    connection.Open();
                    using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                    {
                        var before = TryReadBindingVehicle(connection, transaction, plate);
                        var wants = RequestedGaragesForDatabase(requested, database).ToArray();
                        if (before == null && wants.Length == 0)
                        {
                            transaction.Commit();
                            results.Add(new Dictionary<string, object> {
                                { "database", database }, { "existed", false }, { "changed", false },
                                { "effective", ZeroBits() }, { "download", ZeroBits() }
                            });
                            continue;
                        }
                        if (before == null)
                        {
                            InsertVehicleCopy(connection, transaction, source, payload, database, requested, admin);
                        }
                        else
                        {
                            var nextEffective = ApplyGarageSelection(Value(before, "P_Effective"), requested, database);
                            var nextDownload = ClearManagedDownload(Value(before, "P_Download"), database);
                            using (var command = Procedure(connection, transaction, "Up_PakIssue"))
                            {
                                AddBindingProcedureParameters(command, before, Value(before, "owner_Name") ?? LegacyOwnerRoom(payload));
                                command.Parameters["@P_Effective"].Value = nextEffective;
                                command.Parameters["@P_Download"].Value = nextDownload;
                                command.Parameters["@admin"].Value = admin;
                                command.ExecuteNonQuery();
                            }
                        }
                        var after = ReadBindingVehicle(connection, transaction, plate);
                        AssertGarageSelection(after, requested, database);
                        transaction.Commit();
                        results.Add(new Dictionary<string, object> {
                            { "database", database },
                            { "existed", before != null },
                            { "changed", before == null || Value(before, "P_Effective") != Value(after, "P_Effective") },
                            { "issueId", Value(after, "P_id") },
                            { "effective", Value(after, "P_Effective") },
                            { "download", Value(after, "P_Download") }
                        });
                    }
                }
            }
            return new Dictionary<string, object> { { "verified", true }, { "plate", plate }, { "garages", String.Join(",", requested.ToArray()) }, { "databases", results } };
        }

        private static void InsertVehicleCopy(SqlConnection connection, SqlTransaction transaction, Dictionary<string, object> source,
            Dictionary<string, object> payload, string database, ISet<string> requested, string admin)
        {
            using (var command = Procedure(connection, transaction, "AddIssue"))
            {
                Add(command, "@owner_Name", SqlDbType.VarChar, 20, LegacyOwnerRoom(payload));
                Add(command, "@owner_Add", SqlDbType.VarChar, 80, Value(payload, "ownerAddress") ?? LegacyOwnerRoom(payload));
                Add(command, "@owner_Tel", SqlDbType.VarChar, 80, Value(payload, "ownerPhone") ?? "");
                Add(command, "@owner_Sex", SqlDbType.Int, 0, 0);
                Add(command, "@owner_depa", SqlDbType.VarChar, 50, "PMS");
                Add(command, "@Owner_Image", SqlDbType.VarChar, 80, "");
                Add(command, "@P_plate", SqlDbType.VarChar, 50, Value(source, "P_plate"));
                Add(command, "@P_Color", SqlDbType.VarChar, 10, Value(source, "P_Color") ?? "蓝");
                Add(command, "@Car_Lei", SqlDbType.Int, 0, NumberFromObject(source.ContainsKey("Car_Lei") ? source["Car_Lei"] : null, 1));
                Add(command, "@Sart_Time", SqlDbType.DateTime, 0, DateFromObject(source.ContainsKey("Sart_Time") ? source["Sart_Time"] : null, DateTime.Today));
                Add(command, "@End_Time", SqlDbType.DateTime, 0, DateFromObject(source.ContainsKey("End_Time") ? source["End_Time"] : null, DateTime.Today));
                Add(command, "@Car_ID", SqlDbType.VarChar, 20, Value(source, "Car_ID") ?? "0000000000");
                Add(command, "@Car_Brand", SqlDbType.VarChar, 20, Value(source, "Car_Beand") ?? Value(source, "Car_Brand") ?? Value(payload, "identity") ?? "住户车");
                Add(command, "@Car_Money", SqlDbType.Float, 0, 0);
                Add(command, "@Car_Deposit", SqlDbType.Float, 0, 0);
                Add(command, "@Car_Zt", SqlDbType.Int, 0, NumberFromObject(source.ContainsKey("Car_Zt") ? source["Car_Zt"] : null, 1));
                Add(command, "@P_note", SqlDbType.VarChar, 200, Value(source, "P_note") ?? AppendPmsSource(null));
                Add(command, "@P_Admin", SqlDbType.VarChar, 20, admin);
                Add(command, "@P_Spaces", SqlDbType.VarChar, 20, Value(source, "P_Spaces") ?? "");
                Add(command, "@P_Effective", SqlDbType.VarChar, 256, ApplyGarageSelection(ZeroBits(), requested, database));
                Add(command, "@P_Download", SqlDbType.VarChar, 256, ZeroBits());
                command.ExecuteNonQuery();
            }
        }

        private static Dictionary<string, object> TryReadBindingVehicle(SqlConnection connection, SqlTransaction transaction, string plate)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT * FROM dbo.Car_Issue WITH (UPDLOCK,HOLDLOCK) WHERE P_plate=@plate";
                Add(command, "@plate", SqlDbType.VarChar, 50, plate);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read()) return null;
                    var row = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                    for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                    if (reader.Read()) throw new InvalidOperationException("车辆不唯一，已停止操作");
                    return row;
                }
            }
        }

        private static Dictionary<string, object> ReadBindingVehicle(SqlConnection connection, SqlTransaction transaction, string plate)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT * FROM dbo.Car_Issue WITH (UPDLOCK,HOLDLOCK) WHERE P_plate=@plate";
                Add(command, "@plate", SqlDbType.VarChar, 50, plate);
                return ReadSingleBindingRow(command, "车辆");
            }
        }

        private static Dictionary<string, object> ReadBindingOwner(SqlConnection connection, SqlTransaction transaction, string id)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT UserID,owner_Name,owner_Tel,owner_depa FROM dbo.P_Owner WHERE UserID=@id";
                Add(command, "@id", SqlDbType.VarChar, 30, id);
                return ReadSingleBindingRow(command, "旧库住户");
            }
        }

        private static Dictionary<string, object> ReadSingleBindingRow(SqlCommand command, string label)
        {
            using (var reader = command.ExecuteReader())
            {
                if (!reader.Read()) throw new InvalidOperationException(label + "不存在，请重新查询");
                var row = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
                if (reader.Read()) throw new InvalidOperationException(label + "不唯一，已停止操作");
                return row;
            }
        }

        private static Dictionary<string, object> BindingResult(Dictionary<string, object> vehicle, Dictionary<string, object> previous, Dictionary<string, object> target, string previousId, string targetId)
        {
            return new Dictionary<string, object> { { "verified", true }, { "plate", Value(vehicle, "P_plate") }, { "issueId", Value(vehicle, "P_id") },
                { "previousOwnerId", previousId }, { "targetOwnerId", targetId }, { "previousRoom", Value(previous, "owner_Name") },
                { "previousPhone", Value(previous, "owner_Tel") }, { "targetRoom", Value(target, "owner_Name") }, { "targetPhone", Value(target, "owner_Tel") } };
        }

        private static SqlCommand Procedure(SqlConnection connection, string name)
        {
            var command = connection.CreateCommand(); command.CommandType = CommandType.StoredProcedure; command.CommandText = "dbo." + name; command.CommandTimeout = 30; return command;
        }

        private static SqlCommand Procedure(SqlConnection connection, SqlTransaction transaction, string name)
        {
            var command = Procedure(connection, name);
            command.Transaction = transaction;
            return command;
        }

        private static void Add(SqlCommand command, string name, SqlDbType type, int size, object value)
        {
            var parameter = size > 0 ? command.Parameters.Add(name, type, size) : command.Parameters.Add(name, type);
            parameter.Value = value ?? DBNull.Value;
        }

        private static string Value(Dictionary<string, object> values, string key)
        {
            object value; return values != null && values.TryGetValue(key, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
        }

        private static string LegacyOwnerRoom(Dictionary<string, object> values)
        {
            var room = Clean(Value(values, "ownerRoom")) ?? Clean(Value(values, "ownerAddress"));
            if (room == null)
                throw new InvalidOperationException("旧停车系统的 owner_Name 保存房号，本次操作缺少房号，已停止写入");
            return room;
        }

        private static int Number(Dictionary<string, object> values, string key, int fallback)
        {
            int value; return Int32.TryParse(Value(values, key), out value) ? value : fallback;
        }

        private static double NumberDecimal(Dictionary<string, object> values, string key, double fallback)
        {
            double value; return Double.TryParse(Value(values, key), NumberStyles.Any, CultureInfo.InvariantCulture, out value) ? value : fallback;
        }

        private static DateTime DateValue(Dictionary<string, object> values, string key, DateTime fallback)
        {
            DateTime value; return DateTime.TryParse(Value(values, key), CultureInfo.InvariantCulture, DateTimeStyles.None, out value) ? value : fallback;
        }

        private static string ZeroBits() { return new String('0', 256); }

        internal static ISet<string> RequestedGarageKeys(Dictionary<string, object> payload)
        {
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            object raw;
            if (payload != null && payload.TryGetValue("garages", out raw) && raw is IEnumerable && !(raw is string))
                foreach (var item in (IEnumerable)raw) AddGarageKey(result, Convert.ToString(item, CultureInfo.InvariantCulture));
            if (payload != null && payload.TryGetValue("garageKeys", out raw) && raw is IEnumerable && !(raw is string))
                foreach (var item in (IEnumerable)raw) AddGarageKey(result, Convert.ToString(item, CultureInfo.InvariantCulture));
            var text = Value(payload, "garages") ?? Value(payload, "garageKeys");
            if (!String.IsNullOrWhiteSpace(text) && text.IndexOf("System.", StringComparison.OrdinalIgnoreCase) < 0)
                foreach (var item in text.Split(new[] { ',', ';', '|', ' ' }, StringSplitOptions.RemoveEmptyEntries)) AddGarageKey(result, item);
            return result;
        }

        private static void AddGarageKey(ISet<string> result, string value)
        {
            var key = Clean(value);
            if (key == null || String.Equals(key, "civil", StringComparison.OrdinalIgnoreCase)) return;
            if (!String.Equals(key, "phase1", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(key, "phase2", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(key, "main", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("不支持的车库授权：" + key);
            result.Add(key.ToLowerInvariant());
        }

        internal static string ApplyGarageSelectionForTest(string current, IEnumerable<string> selected, string database)
        {
            return ApplyGarageSelection(current, new HashSet<string>(selected, StringComparer.OrdinalIgnoreCase), database);
        }

        private static string ApplyGarageSelection(string current, ISet<string> selected, string database)
        {
            var bits = NormalizeBits(current);
            foreach (var channel in ManagedGarageChannels(database)) bits[channel - 1] = '0';
            foreach (var key in RequestedGaragesForDatabase(selected, database))
                foreach (var channel in GarageChannels(key)) bits[channel - 1] = '1';
            return new String(bits);
        }

        private static string ClearManagedDownload(string current, string database)
        {
            var bits = NormalizeBits(current);
            foreach (var channel in ManagedGarageChannels(database)) bits[channel - 1] = '0';
            return new String(bits);
        }

        private static char[] NormalizeBits(string value)
        {
            var bits = ZeroBits().ToCharArray();
            if (!String.IsNullOrEmpty(value))
            {
                for (var i = 0; i < value.Length && i < bits.Length; i++)
                    bits[i] = value[i] == '1' ? '1' : '0';
            }
            return bits;
        }

        private static IEnumerable<string> RequestedGaragesForDatabase(ISet<string> selected, string database)
        {
            if (String.Equals(database, "parking1", StringComparison.OrdinalIgnoreCase))
            {
                if (selected.Contains("phase1")) yield return "phase1";
                yield break;
            }
            if (selected.Contains("phase2")) yield return "phase2";
            if (selected.Contains("main")) yield return "main";
        }

        private static IEnumerable<int> ManagedGarageChannels(string database)
        {
            if (String.Equals(database, "parking1", StringComparison.OrdinalIgnoreCase))
            {
                foreach (var channel in GarageChannels("phase1")) yield return channel;
                yield break;
            }
            foreach (var channel in GarageChannels("phase2")) yield return channel;
            foreach (var channel in GarageChannels("main")) yield return channel;
        }

        private static IEnumerable<int> GarageChannels(string key)
        {
            if (String.Equals(key, "phase1", StringComparison.OrdinalIgnoreCase)) return new[] { 5, 7 };
            if (String.Equals(key, "phase2", StringComparison.OrdinalIgnoreCase)) return new[] { 9, 11, 13 };
            if (String.Equals(key, "main", StringComparison.OrdinalIgnoreCase)) return new[] { 15, 17, 19, 21 };
            return new int[0];
        }

        private static void AssertGarageSelection(Dictionary<string, object> vehicle, ISet<string> selected, string database)
        {
            var effective = new String(NormalizeBits(Value(vehicle, "P_Effective")));
            foreach (var key in RequestedGaragesForDatabase(new HashSet<string>(new[] { "phase1", "phase2", "main" }, StringComparer.OrdinalIgnoreCase), database))
            {
                var hasAny = GarageChannels(key).Any(delegate(int channel) { return effective[channel - 1] == '1'; });
                var expected = selected.Contains(key);
                if (hasAny != expected) throw new InvalidOperationException(database + " 车库授权 " + key + " 写入后读回不一致，已回滚");
            }
        }

        private static int NumberFromObject(object value, int fallback)
        {
            int result; return value != null && Int32.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out result) ? result : fallback;
        }

        private static DateTime DateFromObject(object value, DateTime fallback)
        {
            if (value is DateTime) return (DateTime)value;
            DateTime result; return value != null && DateTime.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture, DateTimeStyles.None, out result) ? result : fallback;
        }

        private static Dictionary<string, object> VerifyVehicle(SqlConnection connection, string plate, string label)
        {
            using (var check = connection.CreateCommand())
            {
                check.CommandText = "SELECT TOP 1 P_id, P_plate, End_Time, P_Effective, P_Download FROM Car_Issue WHERE P_plate=@plate ORDER BY P_id DESC";
                Add(check, "@plate", SqlDbType.VarChar, 50, plate);
                using (var reader = check.ExecuteReader())
                {
                    if (!reader.Read()) throw new InvalidOperationException(label + "存储过程执行后未读回车牌");
                    var result = new Dictionary<string, object> { { "verified", true }, { "plate", Convert.ToString(reader["P_plate"]) }, { "issueId", Convert.ToString(reader["P_id"]) } };
                    if (!reader.IsDBNull(reader.GetOrdinal("End_Time"))) result["endDate"] = Convert.ToDateTime(reader["End_Time"]).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    if (!reader.IsDBNull(reader.GetOrdinal("P_Effective"))) result["effective"] = Convert.ToString(reader["P_Effective"]);
                    if (!reader.IsDBNull(reader.GetOrdinal("P_Download"))) result["download"] = Convert.ToString(reader["P_Download"]);
                    return result;
                }
            }
        }

        private static Dictionary<string, object> VerifyRenewalAudit(SqlConnection connection, string plate, string operatorName, int renewalType, int issueId)
        {
            using (var check = connection.CreateCommand())
            {
                // Palte_extend 的 type=5 是月租车延期；按本次类型和流水 ID 倒序取刚写入的一条。
                check.CommandText = @"SELECT TOP 1 ID, P_Admin, P_plate, type
FROM P_moneyKeep
WHERE P_plate=@plate AND type=@type AND P_Admin=@operator
  AND Issue_ID=@issueId
ORDER BY ID DESC";
                Add(check, "@plate", SqlDbType.VarChar, 50, plate);
                Add(check, "@type", SqlDbType.Int, 0, renewalType);
                Add(check, "@operator", SqlDbType.VarChar, 20, operatorName);
                Add(check, "@issueId", SqlDbType.Int, 0, issueId);
                using (var reader = check.ExecuteReader())
                {
                    if (!reader.Read()) return null;
                    return new Dictionary<string, object>
                    {
                        { "id", Convert.ToString(reader["ID"]) },
                        { "operator", Convert.ToString(reader["P_Admin"]) },
                        { "plate", Convert.ToString(reader["P_plate"]) },
                        { "type", Convert.ToString(reader["type"]) },
                    };
                }
            }
        }

        private static Dictionary<string, object> ExecuteMappedProcedure(SqlConnection connection, string procedure, Dictionary<string, object> payload, string plate, string admin, string label)
        {
            using (var command = Procedure(connection, procedure))
            {
                var parameters = ProcedureParameters(connection, procedure);
                AddMappedProcedureParameters(command, parameters, payload, plate, admin);
                command.ExecuteNonQuery();
            }
            return new Dictionary<string, object> { { "verified", true }, { "procedure", procedure }, { "message", label + "已提交，等待设备回执" } };
        }

        private static void ExecuteDownloadVehicle(SqlConnection connection, Dictionary<string, object> payload, string plate, string admin)
        {
            using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
            {
                var vehicle = ReadBindingVehicle(connection, transaction, plate);
                using (var command = Procedure(connection, transaction, "Add_DownloadCard"))
                {
                    var parameters = ProcedureParameters(connection, transaction, "Add_DownloadCard");
                    AddDownloadProcedureParameters(command, parameters, vehicle, payload, plate, admin);
                    command.ExecuteNonQuery();
                }
                transaction.Commit();
            }
        }

        internal static void AddDownloadProcedureParameters(SqlCommand command, IEnumerable<ProcedureParameter> parameters,
            Dictionary<string, object> vehicle, Dictionary<string, object> payload, string plate, string admin)
        {
            foreach (var item in parameters)
            {
                var parameter = new SqlParameter(item.Name, item.Type);
                if (item.Size != 0) parameter.Size = item.Size;
                if (item.IsOutput) parameter.Direction = ParameterDirection.Output;
                else
                {
                    var value = DownloadParameterValue(item.Name, vehicle, payload, plate, admin);
                    if (value == null) throw new InvalidOperationException(command.CommandText + " 参数 " + item.Name + " 无法从旧库车辆记录映射，已停止执行");
                    parameter.Value = value;
                }
                command.Parameters.Add(parameter);
            }
        }

        private static object DownloadParameterValue(string parameterName, Dictionary<string, object> vehicle,
            Dictionary<string, object> payload, string plate, string admin)
        {
            var key = NormalizeName(parameterName);
            if (key == "carid" || key == "car_id") return RawVehicleValue(vehicle, "Car_ID");
            if (key == "pid" || key == "p_id" || key == "issueid" || key == "issue_id") return RawVehicleValue(vehicle, "P_id");
            if (key.Contains("plate")) return plate;
            if (key.Contains("effective") || key.Contains("release")) return RawVehicleValue(vehicle, "P_Effective") ?? Value(payload, "effective");
            if (key.Contains("download")) return RawVehicleValue(vehicle, "P_Download") ?? Value(payload, "download");
            if (key.Contains("admin")) return admin;
            if (key.Contains("color")) return RawVehicleValue(vehicle, "P_Color");
            if (key.Contains("brand") || key.Contains("beand")) return RawVehicleValue(vehicle, "Car_Beand") ?? RawVehicleValue(vehicle, "Car_Brand");
            if (key.Contains("lei") || key.Contains("type")) return RawVehicleValue(vehicle, "Car_Lei");
            if (key.Contains("owner")) return RawVehicleValue(vehicle, "Owner_ID") ?? Value(payload, "ownerId");
            if (key.Contains("space")) return RawVehicleValue(vehicle, "P_Spaces");
            if (key.Contains("note")) return RawVehicleValue(vehicle, "P_note");
            return Value(payload, key);
        }

        private static object RawVehicleValue(Dictionary<string, object> vehicle, string key)
        {
            object value;
            return vehicle != null && vehicle.TryGetValue(key, out value) && value != null && value != DBNull.Value ? value : null;
        }

        private static Dictionary<string, object> VerifyDownloadQueue(SqlConnection connection, string plate)
        {
            if (!ObjectExists(connection, "Car_Download", "U")) throw new InvalidOperationException("设备下载存储过程已执行，但未找到 Car_Download 队列表，无法核验");
            var columns = LoadColumns(connection, "dbo", "Car_Download");
            var plateColumn = columns.Select(delegate(ParkingColumn item) { return item.Name; }).FirstOrDefault(delegate(string name) { return IsPlateColumn(name); });
            if (String.IsNullOrWhiteSpace(plateColumn)) throw new InvalidOperationException("Car_Download 未识别到车牌列，无法核验设备下载任务");
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT COUNT(*) FROM [dbo].[Car_Download] WITH (NOLOCK) WHERE CONVERT(NVARCHAR(100), " + QuoteColumn(plateColumn) + ")=@plate";
                Add(command, "@plate", SqlDbType.VarChar, 50, plate);
                var count = Convert.ToInt32(command.ExecuteScalar());
                if (count <= 0) throw new InvalidOperationException("设备下载存储过程执行后未在 Car_Download 找到该车牌任务");
                return new Dictionary<string, object> { { "verified", true }, { "deviceVerification", "queued" }, { "downloadRows", count }, { "message", "下载任务已写入 Car_Download，现场控制器回执需由设备状态继续核验" } };
            }
        }

        internal sealed class ProcedureParameter { public string Name; public SqlDbType Type; public int Size; public bool IsOutput; }

        // SQL Server 2008 R2 的 sys.parameters 没有 is_nullable。
        // 可为 NULL 也不代表可省略参数；无法映射的输入必须停止，不能默认传 NULL 执行。
        internal const string ProcedureParametersSql = "SELECT p.name, t.name, p.max_length, p.is_output FROM sys.parameters p JOIN sys.types t ON p.user_type_id=t.user_type_id WHERE p.object_id=OBJECT_ID(@name) AND p.parameter_id>0 ORDER BY p.parameter_id";

        internal static List<ProcedureParameter> ReadProcedureParameters(IDataReader reader)
        {
            var result = new List<ProcedureParameter>();
            while (reader.Read())
            {
                var type = SqlType(reader.GetString(1));
                var size = (int)reader.GetInt16(2);
                // 目录中的长度是字节；SqlParameter 的 Unicode 长度按字符，MAX 保留 -1。
                if (size > 0 && (type == SqlDbType.NVarChar || type == SqlDbType.NChar)) size /= 2;
                result.Add(new ProcedureParameter { Name = reader.GetString(0), Type = type, Size = size, IsOutput = reader.GetBoolean(3) });
            }
            return result;
        }

        internal static void AddMappedProcedureParameters(SqlCommand command, IEnumerable<ProcedureParameter> parameters,
            Dictionary<string, object> payload, string plate, string admin)
        {
            foreach (var item in parameters)
            {
                var parameter = new SqlParameter(item.Name, item.Type);
                if (item.Size != 0) parameter.Size = item.Size;
                if (item.IsOutput) parameter.Direction = ParameterDirection.Output;
                else
                {
                    var key = ParameterKey(item.Name);
                    var value = Value(payload, key) ?? (key == "plate" ? plate : key == "admin" ? admin : null);
                    if (value == null) throw new InvalidOperationException(command.CommandText + " 参数 " + item.Name + " 无法从操作字段映射，已停止执行");
                    parameter.Value = value;
                }
                command.Parameters.Add(parameter);
            }
        }

        private static List<ProcedureParameter> ProcedureParameters(SqlConnection connection, string procedure)
        {
            var result = new List<ProcedureParameter>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = ProcedureParametersSql;
                Add(command, "@name", SqlDbType.NVarChar, 300, "dbo." + procedure);
                using (var reader = command.ExecuteReader()) result = ReadProcedureParameters(reader);
            }
            if (result.Count == 0) throw new InvalidOperationException("找不到存储过程 " + procedure + " 的参数定义");
            return result;
        }

        private static List<ProcedureParameter> ProcedureParameters(SqlConnection connection, SqlTransaction transaction, string procedure)
        {
            var result = new List<ProcedureParameter>();
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = ProcedureParametersSql;
                Add(command, "@name", SqlDbType.NVarChar, 300, "dbo." + procedure);
                using (var reader = command.ExecuteReader()) result = ReadProcedureParameters(reader);
            }
            if (result.Count == 0) throw new InvalidOperationException("找不到存储过程 " + procedure + " 的参数定义");
            return result;
        }

        private static SqlDbType SqlType(string type)
        {
            SqlDbType result;
            if (String.Equals(type, "numeric", StringComparison.OrdinalIgnoreCase)) return SqlDbType.Decimal;
            if (Enum.TryParse<SqlDbType>(type, true, out result) && Enum.IsDefined(typeof(SqlDbType), result)) return result;
            throw new InvalidOperationException("下载存储过程使用了尚未支持的参数类型 " + type + "，已停止执行");
        }

        private static string ParameterKey(string name)
        {
            var value = NormalizeName(name); if (value.Contains("plate")) return value.Contains("y") || value.Contains("old") ? "oldPlate" : value.Contains("pak") || value.Contains("new") || value.Contains("n_p") ? "newPlate" : "plate";
            if (value == "carid") return "carId";
            if (value == "pid" || value == "issueid") return "issueId";
            if (value.Contains("effective") || value.Contains("release")) return "effective"; if (value.Contains("download")) return "download"; if (value.Contains("admin")) return "admin"; return value;
        }

        private static ParkingOwnerValues ReadOwner(SqlConnection connection, SqlTransaction transaction,
            ParkingOwnerSource source, Dictionary<string, ParkingColumn> columns, string ownerId, bool lockRow)
        {
            var selected = columns.Where(delegate(KeyValuePair<string, ParkingColumn> item) { return item.Value != null; }).ToList();
            if (selected.Count == 0) throw new InvalidOperationException("住户表没有可更新的资料列");
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                var fields = selected.Select(delegate(KeyValuePair<string, ParkingColumn> item)
                {
                    return QuoteColumn(item.Value.Name) + " AS " + QuoteColumn(item.Key);
                }).ToArray();
                command.CommandText = "SELECT TOP 2 " + String.Join(", ", fields) + " FROM " +
                    QuoteName(source.Schema, source.Table) + (lockRow ? " WITH (UPDLOCK, HOLDLOCK)" : "") +
                    " WHERE CONVERT(NVARCHAR(200), " + QuoteColumn(source.KeyColumn) + ") = @ownerId;";
                command.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = ownerId.Trim();
                command.CommandTimeout = 15;
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read()) throw new InvalidOperationException("旧停车系统中找不到住户 #" + ownerId);
                    var result = new ParkingOwnerValues();
                    foreach (var item in selected)
                    {
                        var value = reader[item.Key];
                        SetOwnerValue(result, item.Key, value == DBNull.Value ? null : Convert.ToString(value));
                    }
                    if (reader.Read()) throw new InvalidOperationException("住户编号 #" + ownerId + " 对应多条记录，已停止更新");
                    return result;
                }
            }
        }

        private static string ReadIssueNote(SqlConnection connection, SqlTransaction transaction, string ownerId,
            string plate, ParkingColumn noteColumn, bool lockRow)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT TOP 2 " + QuoteColumn(noteColumn.Name) + " FROM [dbo].[Car_Issue]" +
                    (lockRow ? " WITH (UPDLOCK, HOLDLOCK)" : "") +
                    " WHERE CONVERT(NVARCHAR(200), [Owner_ID])=@ownerId AND CONVERT(NVARCHAR(100), [P_plate])=@plate;";
                command.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = ownerId.Trim();
                command.Parameters.Add("@plate", SqlDbType.NVarChar, 100).Value = plate.Trim();
                command.CommandTimeout = 15;
                using (var reader = command.ExecuteReader())
                {
                    return ReadUniqueIssueNote(reader, plate);
                }
            }
        }

        internal static string ReadUniqueIssueNote(System.Data.IDataReader reader, string plate)
        {
            if (!reader.Read()) throw new InvalidOperationException("旧停车系统中找不到住户对应的车牌 " + plate);
            // SQL NULL 表示这辆车尚无备注，不表示车牌不存在。保留原始换行供并发比较。
            var note = reader.IsDBNull(0) ? null : Convert.ToString(reader.GetValue(0));
            if (reader.Read()) throw new InvalidOperationException("旧停车系统中该住户的车牌 " + plate + " 存在重复记录，已停止更新，请先核对旧库");
            return note;
        }

        private static void UpdateIssueNote(SqlConnection connection, SqlTransaction transaction, string ownerId,
            string plate, ParkingColumn noteColumn, string before, string after)
        {
            if (after != null && noteColumn.CharacterLimit > 0 && after.Length > noteColumn.CharacterLimit)
                throw new InvalidOperationException("备注最多 " + noteColumn.CharacterLimit + " 个字");
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "UPDATE [dbo].[Car_Issue] SET " + QuoteColumn(noteColumn.Name) + "=@note" +
                    " WHERE CONVERT(NVARCHAR(200), [Owner_ID])=@ownerId AND CONVERT(NVARCHAR(100), [P_plate])=@plate AND " +
                    "ISNULL(CONVERT(NVARCHAR(4000), " + QuoteColumn(noteColumn.Name) + "), N'')=@before;";
                command.Parameters.Add("@note", SqlDbType.NVarChar, Math.Max(1, noteColumn.CharacterLimit > 0 ? noteColumn.CharacterLimit : 4000)).Value =
                    after == null ? (object)DBNull.Value : after;
                command.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = ownerId.Trim();
                command.Parameters.Add("@plate", SqlDbType.NVarChar, 100).Value = plate.Trim();
                command.Parameters.Add("@before", SqlDbType.NVarChar, 4000).Value = before ?? "";
                command.CommandTimeout = 15;
                if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("车辆备注已被其他操作修改，请重新查询后再保存");
            }
        }

        private static void AssertExpectedOwner(ParkingOwnerValues expected, ParkingOwnerValues current,
            Dictionary<string, ParkingColumn> columns)
        {
            foreach (var field in new[] { "name", "phone", "room", "note" })
            {
                if (columns[field] == null) continue;
                var expectedValue = CleanMultiline(GetOwnerValue(expected, field));
                var currentValue = CleanMultiline(GetOwnerValue(current, field));
                if (!String.Equals(expectedValue, currentValue, StringComparison.Ordinal))
                    throw new ParkingOwnerConflictException("旧系统的" + OwnerFieldLabel(field) +
                        "已被其他操作修改，请重新查询后再保存");
            }
        }

        private static void AssertOwnerWritten(ParkingOwnerValues desired, ParkingOwnerValues actual,
            Dictionary<string, ParkingColumn> columns)
        {
            foreach (var field in new[] { "name", "phone", "room", "note" })
            {
                if (columns[field] == null) continue;
                if (!String.Equals(CleanMultiline(GetOwnerValue(desired, field)),
                    CleanMultiline(GetOwnerValue(actual, field)), StringComparison.Ordinal))
                    throw new InvalidOperationException("旧系统的" + OwnerFieldLabel(field) + "写入后读回不一致，已回滚");
            }
        }

        private static bool OwnerMatches(ParkingOwnerValues desired, ParkingOwnerValues actual,
            Dictionary<string, ParkingColumn> columns)
        {
            foreach (var field in new[] { "name", "phone", "room", "note" })
            {
                if (columns[field] == null) return false;
                if (!String.Equals(CleanMultiline(GetOwnerValue(desired, field)),
                    CleanMultiline(GetOwnerValue(actual, field)), StringComparison.Ordinal)) return false;
            }
            return true;
        }

        private static bool OwnerMatchesWithIssueNote(ParkingOwnerValues desired, ParkingOwnerValues actual,
            Dictionary<string, ParkingColumn> columns, ParkingColumn issueNote)
        {
            return OwnerMatches(desired, actual, columns) ||
                (String.Equals(CleanMultiline(desired.name), CleanMultiline(actual.name), StringComparison.Ordinal) &&
                 String.Equals(CleanMultiline(desired.phone), CleanMultiline(actual.phone), StringComparison.Ordinal) &&
                 String.Equals(CleanMultiline(desired.room), CleanMultiline(actual.room), StringComparison.Ordinal) &&
                 String.Equals(CleanMultiline(desired.note), CleanMultiline(actual.note), StringComparison.Ordinal));
        }

        private static void AssertOwnerWrittenWithIssueNote(ParkingOwnerValues desired, ParkingOwnerValues actual,
            Dictionary<string, ParkingColumn> columns, ParkingColumn issueNote)
        {
            foreach (var field in new[] { "name", "phone", "room" })
            {
                if (columns[field] != null && !String.Equals(CleanMultiline(GetOwnerValue(desired, field)),
                    CleanMultiline(GetOwnerValue(actual, field)), StringComparison.Ordinal))
                    throw new InvalidOperationException("旧系统的" + OwnerFieldLabel(field) + "写入后读回不一致，已回滚");
            }
            if (!String.Equals(CleanMultiline(desired.note), CleanMultiline(actual.note), StringComparison.Ordinal))
                throw new InvalidOperationException("旧系统的备注写入后读回不一致，已回滚");
        }

        private static void AddOwnerAssignment(SqlCommand command, List<string> assignments, ParkingColumn column,
            string field, string before, string after)
        {
            if (column == null)
            {
                if (!String.Equals(CleanMultiline(before), CleanMultiline(after), StringComparison.Ordinal))
                    throw new InvalidOperationException("旧系统住户表未识别到" + OwnerFieldLabel(field) + "列，已停止更新");
                return;
            }
            if (String.Equals(CleanMultiline(before), CleanMultiline(after), StringComparison.Ordinal)) return;
            if (after == null && !column.Nullable)
                throw new InvalidOperationException(OwnerFieldLabel(field) + "不能清空");
            if (after != null && column.CharacterLimit > 0 && after.Length > column.CharacterLimit)
                throw new InvalidOperationException(OwnerFieldLabel(field) + "最多 " + column.CharacterLimit + " 个字，本次填写了 " + after.Length + " 个字");
            var parameter = "@value_" + field;
            assignments.Add(QuoteColumn(column.Name) + " = " + parameter);
            command.Parameters.Add(parameter, SqlDbType.NVarChar, Math.Max(1, Math.Min(4000,
                column.CharacterLimit > 0 ? column.CharacterLimit : Math.Max(1, after == null ? 1 : after.Length)))).Value =
                after == null ? (object)DBNull.Value : after;
        }

        private static ParkingColumn ResolveOwnerColumn(List<ParkingColumn> columns, string semantic, string hint)
        {
            if (!String.IsNullOrWhiteSpace(hint))
            {
                var hinted = columns.FirstOrDefault(delegate(ParkingColumn item)
                {
                    return String.Equals(item.Name, hint.Trim(), StringComparison.OrdinalIgnoreCase) &&
                        OwnerColumnScore(item.Name, semantic) > 0;
                });
                if (hinted != null) return hinted;
            }
            ParkingColumn best = null;
            var bestScore = 0;
            foreach (var item in columns)
            {
                var score = OwnerColumnScore(item.Name, semantic);
                if (score > bestScore || (score == bestScore && score > 0 && best != null &&
                    String.Compare(item.Name, best.Name, StringComparison.OrdinalIgnoreCase) < 0))
                {
                    best = item;
                    bestScore = score;
                }
            }
            return best;
        }

        internal static string ResolveOwnerColumnForTest(string semantic, string hint, params string[] names)
        {
            var columns = names.Select(delegate(string name)
            {
                return new ParkingColumn { Name = name, Searchable = true, Nullable = true, CharacterLimit = 400 };
            }).ToList();
            var result = ResolveOwnerColumn(columns, semantic, hint);
            return result == null ? null : result.Name;
        }

        private static int OwnerColumnScore(string column, string semantic)
        {
            var normalized = NormalizeName(column);
            string[] aliases;
            // P_Owner.owner_Name 是房号，不是姓名。姓名只接受明确的人名列，避免把
            // 228-31-702 之类房号显示或回写为住户姓名。
            if (semantic == "name") aliases = new[] { "username", "customername", "personname", "residentname", "pname", "姓名", "业主姓名", "住户姓名" };
            else if (semantic == "phone") aliases = new[] { "mobilephone", "mobile", "telephone", "phone", "tel", "ptel", "手机", "电话", "联系电话" };
            else if (semantic == "room") aliases = new[] { "ownername", "roomnumber", "roomno", "houseno", "house", "address", "addr", "room", "proom", "房号", "地址", "住址" };
            else aliases = new[] { "remarks", "remark", "note", "memo", "comment", "pnote", "备注" };
            var best = 0;
            foreach (var alias in aliases)
            {
                if (normalized == alias) best = Math.Max(best, 100);
                else if (normalized.EndsWith(alias, StringComparison.Ordinal)) best = Math.Max(best, 80);
                else if (normalized.Contains(alias)) best = Math.Max(best, 40);
            }
            return best;
        }

        private static string AppendPmsSource(string note)
        {
            const string marker = "操作来源：PMS系统";
            if (note != null && note.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0) return note;
            return String.IsNullOrWhiteSpace(note) ? marker : note.TrimEnd() + Environment.NewLine + marker;
        }

        internal static string AppendPmsSourceForTest(string note)
        {
            return AppendPmsSource(note);
        }

        private static string Clean(string value)
        {
            return String.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }

        private static string CleanMultiline(string value)
        {
            return String.IsNullOrWhiteSpace(value) ? null : value.Replace("\r\n", "\n").Replace("\r", "\n").Trim();
        }

        private static string GetOwnerValue(ParkingOwnerValues value, string field)
        {
            if (field == "name") return value.name;
            if (field == "phone") return value.phone;
            if (field == "room") return value.room;
            return value.note;
        }

        private static void SetOwnerValue(ParkingOwnerValues value, string field, string text)
        {
            text = CleanMultiline(text);
            if (field == "name") value.name = text;
            else if (field == "phone") value.phone = text;
            else if (field == "room") value.room = text;
            else value.note = text;
        }

        private static string OwnerFieldLabel(string field)
        {
            if (field == "name") return "姓名";
            if (field == "phone") return "电话";
            if (field == "room") return "房号";
            return "备注";
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
                ApplicationName = "PMS Parking Gateway"
            }.ConnectionString;
        }

        private sealed class ParkingColumn
        {
            public string Name { get; set; }
            public bool Searchable { get; set; }
            public bool Nullable { get; set; }
            public int CharacterLimit { get; set; }
        }

        private sealed class ParkingOwnerSource
        {
            public string Schema { get; set; }
            public string Table { get; set; }
            public string KeyColumn { get; set; }
            public List<ParkingColumn> Columns { get; set; }
        }

        private static ParkingOwnerSource FindOwnerSource(SqlConnection connection)
        {
            var foreignKeySource = FindOwnerSourceFromForeignKey(connection);
            if (foreignKeySource != null) return foreignKeySource;

            var candidates = new List<ParkingOwnerCandidate>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT s.[name], t.[name], c.[name]
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
WHERE t.object_id <> OBJECT_ID(N'[dbo].[Car_Issue]')
  AND LOWER(REPLACE(REPLACE(c.[name], '_', ''), '-', '')) IN
      ('ownerid', 'userid', 'customerid', 'personid', 'id')
ORDER BY s.[name], t.[name], c.column_id;";
                command.CommandTimeout = 10;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        candidates.Add(new ParkingOwnerCandidate
                        {
                            Schema = reader.GetString(0),
                            Table = reader.GetString(1),
                            KeyColumn = reader.GetString(2)
                        });
                    }
                }
            }

            ParkingOwnerSource best = null;
            var bestScore = Int32.MinValue;
            foreach (var candidate in candidates)
            {
                var columns = LoadColumns(connection, candidate.Schema, candidate.Table);
                var score = OwnerCandidateScore(candidate, columns);
                if (score < 3 || score <= bestScore || !HasOwnerOverlap(connection, candidate)) continue;
                bestScore = score;
                best = new ParkingOwnerSource
                {
                    Schema = candidate.Schema,
                    Table = candidate.Table,
                    KeyColumn = candidate.KeyColumn,
                    Columns = columns
                };
            }
            return best;
        }

        private sealed class ParkingOwnerCandidate
        {
            public string Schema { get; set; }
            public string Table { get; set; }
            public string KeyColumn { get; set; }
        }

        private static ParkingOwnerSource FindOwnerSourceFromForeignKey(SqlConnection connection)
        {
            var candidates = new List<ParkingOwnerCandidate>();
            ParkingOwnerSource best = null;
            var bestScore = Int32.MinValue;
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT rs.[name], rt.[name], rc.[name]
FROM sys.foreign_key_columns fkc
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fkc.parent_object_id = OBJECT_ID(N'[dbo].[Car_Issue]')
  AND LOWER(REPLACE(REPLACE(pc.[name], '_', ''), '-', '')) = 'ownerid'
ORDER BY rs.[name], rt.[name], rc.column_id;";
                command.CommandTimeout = 10;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        candidates.Add(new ParkingOwnerCandidate
                        {
                            Schema = reader.GetString(0),
                            Table = reader.GetString(1),
                            KeyColumn = reader.GetString(2)
                        });
                    }
                }
            }
            foreach (var candidate in candidates)
            {
                var columns = LoadColumns(connection, candidate.Schema, candidate.Table);
                // 一个数据库可能给 Car_Issue.Owner_ID 建了多个外键；不能再用 TOP 1
                // 随机选表。P_note 在 Car_Issue，本处只按 P_Owner/UserID 及住户字段选表。
                var score = OwnerCandidateScore(candidate, columns);
                if (!HasOwnerOverlap(connection, candidate) || score <= bestScore) continue;
                bestScore = score;
                best = new ParkingOwnerSource
                {
                    Schema = candidate.Schema,
                    Table = candidate.Table,
                    KeyColumn = candidate.KeyColumn,
                    Columns = columns
                };
            }
            return best;
        }

        private static int OwnerCandidateScore(ParkingOwnerCandidate candidate, List<ParkingColumn> columns)
        {
            var table = NormalizeName(candidate.Table);
            var key = NormalizeName(candidate.KeyColumn);
            var score = table.Contains("owner") || table.Contains("user") || table.Contains("customer") ||
                table.Contains("person") || table.Contains("业主") || table.Contains("住户") ? 4 : 0;
            if (table == "powner") score += 100;
            if (key == "ownerid") score += 4;
            if (key == "userid") score += 40;
            foreach (var column in columns)
            {
                var name = NormalizeName(column.Name);
                if (name == "ownername") score += 20;
                else if (name.Contains("name") || name.Contains("姓名") || name.Contains("业主")) score += 2;
                if (name.Contains("phone") || name.Contains("mobile") || name.Contains("tel") || name.Contains("电话") || name.Contains("手机")) score += 2;
                if (name.Contains("room") || name.Contains("house") || name.Contains("address") || name.Contains("房号") || name.Contains("地址")) score += 2;
                if (name.Contains("note") || name.Contains("remark") || name.Contains("备注")) score += 1;
            }
            return score;
        }

        private static bool HasOwnerOverlap(SqlConnection connection, ParkingOwnerCandidate candidate)
        {
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT TOP 1 1 FROM [dbo].[Car_Issue] c WITH (NOLOCK) INNER JOIN " +
                    QuoteName(candidate.Schema, candidate.Table) + " o WITH (NOLOCK) ON " +
                    "CONVERT(NVARCHAR(200), c.[Owner_ID]) = CONVERT(NVARCHAR(200), o." + QuoteColumn(candidate.KeyColumn) + ") " +
                    "WHERE c.[Owner_ID] IS NOT NULL;";
                command.CommandTimeout = 5;
                return command.ExecuteScalar() != null;
            }
        }

        private static string NormalizeName(string value)
        {
            return (value ?? "").ToLowerInvariant().Replace("@", "").Replace("_", "").Replace("-", "").Replace(" ", "");
        }

        private static List<ParkingColumn> LoadColumns(SqlConnection connection, string schema, string table)
        {
            var columns = new List<ParkingColumn>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT c.[name], t.[name], c.max_length, c.is_nullable
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
WHERE c.object_id = OBJECT_ID(@qualified)
ORDER BY c.column_id;";
                command.Parameters.Add("@qualified", SqlDbType.NVarChar, 300).Value = QuoteName(schema, table);
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
                                type == "nchar" || type == "text" || type == "ntext",
                            Nullable = reader.GetBoolean(3),
                            CharacterLimit = CharacterLimit(type, reader.GetInt16(2))
                        });
                    }
                }
            }
            return columns;
        }

        private static int CharacterLimit(string type, short maxLength)
        {
            if (maxLength < 0) return 4000;
            if (type == "nvarchar" || type == "nchar") return maxLength / 2;
            if (type == "varchar" || type == "char") return maxLength;
            return 0;
        }

        private enum ParkingSearchKind
        {
            House,
            Plate,
            PlateTail,
            Phone,
            Resident
        }

        private sealed class ParkingSearchPlan
        {
            public ParkingSearchKind Kind { get; set; }
            public List<string> Patterns { get; set; }
            public string HouseLane { get; set; }
        }

        private sealed class ParkingSearchColumn
        {
            public string Alias { get; set; }
            public ParkingColumn Column { get; set; }
        }

        private sealed class ParkingHistoryColumns
        {
            public string IssueId { get; set; }
            public string NewPlate { get; set; }
            public string RowId { get; set; }
            public string OccurredAt { get; set; }
        }

        private static ParkingSearchPlan BuildSearchPlan(string input)
        {
            var term = String.IsNullOrWhiteSpace(input) ? "" : input.Trim();
            var address = Regex.Replace(term, @"\s+", "")
                .Replace("弄", "/").Replace("幢", "/").Replace("栋", "/").Replace("号", "/")
                .Replace("室", "").Replace('\\', '/');
            var fullHouse = Regex.Match(address, @"^(198|228)[/-](\d{1,2})[/-](\d{2,4})(?:[/-]\d+)?$");
            var shortHouse = fullHouse.Success
                ? Match.Empty
                : Regex.Match(address, @"^(\d{1,2})[/-](\d{2,4})(?:[/-]\d{1,2})?$");
            if (fullHouse.Success || shortHouse.Success)
            {
                var lane = fullHouse.Success ? fullHouse.Groups[1].Value : null;
                var buildingValue = fullHouse.Success ? fullHouse.Groups[2].Value : shortHouse.Groups[1].Value;
                var roomValue = fullHouse.Success ? fullHouse.Groups[3].Value : shortHouse.Groups[2].Value;
                var buildings = NumericForms(buildingValue, 2);
                var rooms = NumericForms(roomValue, roomValue.Length);
                var patterns = new List<string>();
                foreach (var building in buildings)
                foreach (var room in rooms)
                foreach (var firstSeparator in new[] { "/", "-" })
                foreach (var secondSeparator in new[] { "/", "-" })
                {
                    var body = building + secondSeparator + room;
                    var escapedBody = EscapeLike(body);

                    // 裸房号必须从字段开头匹配，不能用前置通配符，否则 12/101 会误中 112/101。
                    // “已隐藏”是旧库已经确认存在的固定前缀，因此单独列出，不放宽成任意文字。
                    AddBoundedHousePatterns(patterns, escapedBody);
                    AddBoundedHousePatterns(patterns, EscapeLike("已隐藏") + escapedBody);

                    // 完整弄号允许前面存在“已隐藏”等旧系统标记，但楼栋前必须有分隔符边界。
                    var prefixedPattern = lane == null
                        ? "%" + firstSeparator + escapedBody
                        : "%" + EscapeLike(lane + firstSeparator + body);
                    AddBoundedHousePatterns(patterns, prefixedPattern);
                }
                return new ParkingSearchPlan { Kind = ParkingSearchKind.House, Patterns = patterns, HouseLane = lane };
            }

            var compact = Regex.Replace(term, @"\s+", "").ToUpperInvariant();
            if (Regex.IsMatch(compact, @"^[\u4e00-\u9fff][A-Z][A-Z0-9挂学警港澳]{5,6}$"))
                return SinglePattern(ParkingSearchKind.Plate, "%" + EscapeLike(compact) + "%");
            if (Regex.IsMatch(compact, @"^[A-Z0-9]{4,6}$"))
                return SinglePattern(ParkingSearchKind.PlateTail, "%" + EscapeLike(compact));

            var digits = Regex.Replace(term, @"[\s-]", "");
            if (Regex.IsMatch(digits, @"^\d{7,11}$"))
                return SinglePattern(ParkingSearchKind.Phone, "%" + EscapeLike(digits) + "%");
            if (Regex.IsMatch(term, @"^[\u4e00-\u9fff·]{2,20}$"))
                return SinglePattern(ParkingSearchKind.Resident, "%" + EscapeLike(term) + "%");
            if (Regex.IsMatch(digits, @"^\d{1,6}$"))
                throw new InvalidOperationException("数字信息太少：查房号请输入“楼栋/室”，如 6/502；查车牌尾号至少输入 4 位；查电话至少输入 7 位");
            throw new InvalidOperationException("无法识别查询内容：请输入房号、住户姓名、7 位以上电话、完整车牌或至少 4 位车牌尾号");
        }

        private static ParkingSearchPlan SinglePattern(ParkingSearchKind kind, string pattern)
        {
            return new ParkingSearchPlan { Kind = kind, Patterns = new List<string> { pattern } };
        }

        private static void AddBoundedHousePatterns(List<string> patterns, string basePattern)
        {
            // 结尾只能是记录结尾、卡序号，或旧库已确认的“换车牌”操作说明。
            // 禁止直接追加 `%`，否则 6/502 会再次命中 6/5021。
            AddVariant(patterns, basePattern);
            AddVariant(patterns, basePattern + "/%");
            AddVariant(patterns, basePattern + "-%");
            AddVariant(patterns, basePattern + EscapeLike("换车牌"));
        }

        private static bool SearchAppliesToDatabase(
            ParkingSearchPlan plan,
            string database,
            string phase1Database,
            string phase2Database)
        {
            if (plan.Kind != ParkingSearchKind.House || String.IsNullOrWhiteSpace(plan.HouseLane)) return true;
            if (plan.HouseLane == "198")
                return String.Equals(database, phase1Database, StringComparison.OrdinalIgnoreCase);
            if (plan.HouseLane == "228")
                return String.Equals(database, phase2Database, StringComparison.OrdinalIgnoreCase);
            return false;
        }

        private static List<string> NumericForms(string value, int paddedLength)
        {
            var result = new List<string>();
            AddVariant(result, value);
            int number;
            if (Int32.TryParse(value, out number))
            {
                AddVariant(result, number.ToString(CultureInfo.InvariantCulture));
                if (paddedLength > 1) AddVariant(result, number.ToString(new string('0', paddedLength), CultureInfo.InvariantCulture));
            }
            return result;
        }

        private static List<ParkingSearchColumn> SearchColumns(ParkingSearchKind kind, List<ParkingColumn> vehicle, List<ParkingColumn> owner)
        {
            var result = new List<ParkingSearchColumn>();
            if (kind == ParkingSearchKind.Plate || kind == ParkingSearchKind.PlateTail)
            {
                foreach (var column in vehicle.Where(delegate(ParkingColumn item) { return IsPlateColumn(item.Name); }))
                    result.Add(new ParkingSearchColumn { Alias = "c", Column = column });
            }
            else if (kind == ParkingSearchKind.Phone)
            {
                foreach (var column in owner.Where(delegate(ParkingColumn item) { return OwnerColumnScore(item.Name, "phone") > 0; }))
                    result.Add(new ParkingSearchColumn { Alias = "o", Column = column });
            }
            else if (kind == ParkingSearchKind.House)
            {
                // 旧库把“198-6-402”放在 P_Owner.owner_Name，因此按房号语义选择住户列。
                foreach (var column in owner.Where(delegate(ParkingColumn item)
                {
                    return OwnerColumnScore(item.Name, "room") > 0 || OwnerColumnScore(item.Name, "name") > 0;
                })) result.Add(new ParkingSearchColumn { Alias = "o", Column = column });
            }
            else
            {
                foreach (var column in owner.Where(delegate(ParkingColumn item)
                {
                    return OwnerColumnScore(item.Name, "name") > 0 || OwnerColumnScore(item.Name, "room") > 0;
                })) result.Add(new ParkingSearchColumn { Alias = "o", Column = column });
            }
            return result;
        }

        private static bool IsPlateColumn(string name)
        {
            var normalized = NormalizeName(name);
            return normalized == "pplate" || normalized == "plate" || normalized.Contains("plateno") ||
                normalized.Contains("carno") || normalized.Contains("carnumber") || normalized.Contains("license");
        }

        private static string SearchKindLabel(ParkingSearchKind kind)
        {
            if (kind == ParkingSearchKind.House) return "房号";
            if (kind == ParkingSearchKind.Phone) return "电话";
            if (kind == ParkingSearchKind.Resident) return "住户姓名";
            return "车牌";
        }

        private static void AttachPlateChangeTimes(SqlConnection connection, List<ParkingSearchRow> rows)
        {
            if (!ObjectExists(connection, "Up_Issue", "U") || rows.Count == 0) return;
            var columns = LoadHistoryColumns(connection);
            if (columns == null) return;
            foreach (var row in rows)
            {
                object issueValue;
                object plateValue;
                if (!TryField(row.fields, new[] { "p_id", "pid", "issueid" }, out issueValue) ||
                    !TryField(row.fields, new[] { "p_plate", "pplate", "plate" }, out plateValue)) continue;
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT TOP 1 " + QuoteColumn(columns.OccurredAt) + " FROM [dbo].[Up_Issue] WITH (NOLOCK) " +
                        "WHERE CONVERT(NVARCHAR(100), " + QuoteColumn(columns.IssueId) + ") = @issueId " +
                        "AND CONVERT(NVARCHAR(100), " + QuoteColumn(columns.NewPlate) + ") = @plate " +
                        "ORDER BY " + QuoteColumn(columns.OccurredAt) + " DESC" +
                        (String.IsNullOrWhiteSpace(columns.RowId) ? "" : ", " + QuoteColumn(columns.RowId) + " DESC") + ";";
                    command.Parameters.Add("@issueId", SqlDbType.NVarChar, 100).Value = Convert.ToString(issueValue, CultureInfo.InvariantCulture);
                    command.Parameters.Add("@plate", SqlDbType.NVarChar, 100).Value = Convert.ToString(plateValue, CultureInfo.InvariantCulture);
                    command.CommandTimeout = 5;
                    var value = command.ExecuteScalar();
                    if (value == null || value == DBNull.Value) continue;
                    DateTime occurredAt;
                    if (!DateTime.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture, DateTimeStyles.None, out occurredAt)) continue;
                    row.fields["PmsMeta__PlateChangedAt"] = new DateTimeOffset(DateTime.SpecifyKind(occurredAt, DateTimeKind.Unspecified), TimeSpan.FromHours(8)).ToString("o", CultureInfo.InvariantCulture);
                }
            }
        }

        private static ParkingHistoryColumns LoadHistoryColumns(SqlConnection connection)
        {
            var columns = new List<KeyValuePair<string, string>>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT c.[name], t.[name]
FROM sys.columns c
JOIN sys.types t ON c.user_type_id = t.user_type_id
WHERE c.object_id = OBJECT_ID(N'[dbo].[Up_Issue]')
ORDER BY c.column_id;";
                command.CommandTimeout = 5;
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) columns.Add(new KeyValuePair<string, string>(reader.GetString(0), reader.GetString(1).ToLowerInvariant()));
            }
            var issue = FindNamedColumn(columns, new[] { "issueid", "issue_id" });
            var newPlate = FindNamedColumn(columns, new[] { "n_p_plate", "npplate", "newplate", "new_plate" });
            var rowId = FindNamedColumn(columns, new[] { "p_id", "pid", "id" });
            var occurred = columns
                .Where(delegate(KeyValuePair<string, string> item)
                {
                    return (item.Value == "datetime" || item.Value == "datetime2" || item.Value == "smalldatetime" || item.Value == "date") &&
                        HistoryTimeColumnScore(item.Key) >= 80;
                })
                .OrderByDescending(delegate(KeyValuePair<string, string> item) { return HistoryTimeColumnScore(item.Key); })
                .Select(delegate(KeyValuePair<string, string> item) { return item.Key; })
                .FirstOrDefault();
            return String.IsNullOrWhiteSpace(issue) || String.IsNullOrWhiteSpace(newPlate) || String.IsNullOrWhiteSpace(occurred)
                ? null : new ParkingHistoryColumns { IssueId = issue, NewPlate = newPlate, RowId = rowId, OccurredAt = occurred };
        }

        private static string FindNamedColumn(IEnumerable<KeyValuePair<string, string>> columns, IEnumerable<string> aliases)
        {
            var normalized = new HashSet<string>(aliases.Select(NormalizeName), StringComparer.OrdinalIgnoreCase);
            var match = columns.FirstOrDefault(delegate(KeyValuePair<string, string> item) { return normalized.Contains(NormalizeName(item.Key)); });
            return match.Key;
        }

        private static int HistoryTimeColumnScore(string name)
        {
            var normalized = NormalizeName(name);
            if (normalized.Contains("uptime") || normalized.Contains("updatetime") || normalized.Contains("changetime")) return 100;
            if (normalized.Contains("update") || normalized.Contains("change") || normalized.StartsWith("up")) return 80;
            if (normalized.Contains("time") || normalized.Contains("date")) return 40;
            return 0;
        }

        private static bool TryField(Dictionary<string, object> fields, IEnumerable<string> aliases, out object value)
        {
            var normalized = new HashSet<string>(aliases.Select(NormalizeName), StringComparer.OrdinalIgnoreCase);
            foreach (var entry in fields)
            {
                if (!normalized.Contains(NormalizeName(entry.Key))) continue;
                value = entry.Value;
                return true;
            }
            value = null;
            return false;
        }

        internal static string SearchKindForTest(string term)
        {
            return BuildSearchPlan(term).Kind.ToString();
        }

        internal static List<string> SearchPatternsForTest(string term)
        {
            return BuildSearchPlan(term).Patterns;
        }

        internal static bool SearchAppliesToDatabaseForTest(string term, string database, string phase1Database, string phase2Database)
        {
            return SearchAppliesToDatabase(BuildSearchPlan(term), database, phase1Database, phase2Database);
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

        private static string QuoteName(string schema, string table)
        {
            return "[" + schema.Replace("]", "]]" ) + "].[" + table.Replace("]", "]]" ) + "]";
        }
    }
}
