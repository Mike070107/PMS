using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Linq;

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
                var procedures = new[] { "AddIssue", "Palte_extend", "Up_PakIssue", "Add_Del_Plate", "Add_DownloadCard" };
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

                var variants = SearchVariants(term);
                using (var command = connection.CreateCommand())
                {
                    var predicates = new List<string>();
                    for (var valueIndex = 0; valueIndex < variants.Count; valueIndex++)
                    {
                        var parameterName = "@term" + valueIndex;
                        command.Parameters.Add(parameterName, SqlDbType.NVarChar, 200).Value = "%" + EscapeLike(variants[valueIndex]) + "%";
                        foreach (var column in searchable)
                            predicates.Add("CONVERT(NVARCHAR(4000), c." + QuoteColumn(column.Name) + ") LIKE " + parameterName + " ESCAPE N'~'");
                        foreach (var column in ownerSearchable)
                            predicates.Add("CONVERT(NVARCHAR(4000), o." + QuoteColumn(column.Name) + ") LIKE " + parameterName + " ESCAPE N'~'");
                    }
                    var select = "c.*";
                    var join = "";
                    if (ownerSource != null)
                    {
                        var ownerFields = new List<string>();
                        foreach (var column in ownerSource.Columns)
                        {
                            if (ownerFields.Count >= 35) break;
                            ownerFields.Add("o." + QuoteColumn(column.Name) + " AS " + QuoteColumn("Owner__" + column.Name));
                        }
                        if (ownerFields.Count > 0) select += ", " + String.Join(", ", ownerFields.ToArray());
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
                    return rows;
                }
            }
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
                    { "note", ResolveOwnerColumn(source.Columns, "note", hints.note) }
                };
                if (columns["note"] == null)
                    throw new InvalidOperationException(task.database + " 的住户表未识别到备注列，已停止更新，防止丢失 PMS 操作来源");

                using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    var current = ReadOwner(connection, transaction, source, columns, task.externalOwnerId, true);
                    var requested = task.values ?? new ParkingOwnerValues();
                    var desired = new ParkingOwnerValues
                    {
                        name = Clean(requested.name),
                        phone = Clean(requested.phone),
                        room = Clean(requested.room),
                        note = AppendPmsSource(CleanMultiline(requested.note))
                    };
                    // 数据库已成功提交但首次回报遇到断网时，同一任务会再次领取。
                    // 读到目标值即按幂等成功返回，不能把已经完成的写入误报成并发冲突。
                    if (OwnerMatches(desired, current, columns))
                    {
                        transaction.Commit();
                        return current;
                    }
                    AssertExpectedOwner(task.expected ?? new ParkingOwnerValues(), current, columns);

                    var assignments = new List<string>();
                    using (var update = connection.CreateCommand())
                    {
                        update.Transaction = transaction;
                        AddOwnerAssignment(update, assignments, columns["name"], "name", current.name, desired.name);
                        AddOwnerAssignment(update, assignments, columns["phone"], "phone", current.phone, desired.phone);
                        AddOwnerAssignment(update, assignments, columns["room"], "room", current.room, desired.room);
                        AddOwnerAssignment(update, assignments, columns["note"], "note", current.note, desired.note);
                        if (assignments.Count == 0)
                            throw new InvalidOperationException("住户资料没有发生变化");
                        update.CommandText = "UPDATE " + QuoteName(source.Schema, source.Table) + " SET " +
                            String.Join(", ", assignments.ToArray()) + " WHERE CONVERT(NVARCHAR(200), " +
                            QuoteColumn(source.KeyColumn) + ") = @ownerId;";
                        update.Parameters.Add("@ownerId", SqlDbType.NVarChar, 200).Value = task.externalOwnerId.Trim();
                        update.CommandTimeout = 15;
                        var affected = update.ExecuteNonQuery();
                        if (affected != 1) throw new InvalidOperationException("住户更新影响了 " + affected + " 条记录，已回滚");
                    }

                    var result = ReadOwner(connection, transaction, source, columns, task.externalOwnerId, false);
                    AssertOwnerWritten(desired, result, columns);
                    transaction.Commit();
                    return result;
                }
            }
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
            if (semantic == "name") aliases = new[] { "ownername", "username", "customername", "personname", "residentname", "name", "pname", "姓名", "业主姓名", "住户姓名" };
            else if (semantic == "phone") aliases = new[] { "mobilephone", "mobile", "telephone", "phone", "tel", "ptel", "手机", "电话", "联系电话" };
            else if (semantic == "room") aliases = new[] { "roomnumber", "roomno", "houseno", "house", "address", "addr", "room", "proom", "房号", "地址", "住址" };
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
            using (var command = connection.CreateCommand())
            {
                command.CommandText = @"
SELECT TOP 1 rs.[name], rt.[name], rc.[name]
FROM sys.foreign_key_columns fkc
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fkc.parent_object_id = OBJECT_ID(N'[dbo].[Car_Issue]')
  AND LOWER(REPLACE(REPLACE(pc.[name], '_', ''), '-', '')) = 'ownerid';";
                command.CommandTimeout = 10;
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read()) return null;
                    var schema = reader.GetString(0);
                    var table = reader.GetString(1);
                    var keyColumn = reader.GetString(2);
                    reader.Close();
                    return new ParkingOwnerSource
                    {
                        Schema = schema,
                        Table = table,
                        KeyColumn = keyColumn,
                        Columns = LoadColumns(connection, schema, table)
                    };
                }
            }
        }

        private static int OwnerCandidateScore(ParkingOwnerCandidate candidate, List<ParkingColumn> columns)
        {
            var table = NormalizeName(candidate.Table);
            var key = NormalizeName(candidate.KeyColumn);
            var score = table.Contains("owner") || table.Contains("user") || table.Contains("customer") ||
                table.Contains("person") || table.Contains("业主") || table.Contains("住户") ? 4 : 0;
            if (key == "ownerid") score += 4;
            foreach (var column in columns)
            {
                var name = NormalizeName(column.Name);
                if (name.Contains("name") || name.Contains("姓名") || name.Contains("业主")) score += 2;
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
            return (value ?? "").ToLowerInvariant().Replace("_", "").Replace("-", "").Replace(" ", "");
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
