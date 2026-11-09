using System;
using System.Data;
using System.Data.SqlClient;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Pms.AccessCardAgent
{
    internal sealed class LegacySequenceResult
    {
        public int IssuedCount { get; set; }
        public int NextSequence { get; set; }
    }

    internal sealed class LegacyHistoryEntry
    {
        public long personId { get; set; }
        public string personNo { get; set; }
        public int sequence { get; set; }
        public string icCardNo { get; set; }
        public string issuedAt { get; set; }
        public string personName { get; set; }
        /** 捷顺 MC.CardInfo.ID；用于 /cards/:id 定位。 */
        public long? cardInfoId { get; set; }
        /** 捷顺 HR.Person.OptDate（人事资料添加时间）。 */
        public string personCreatedAt { get; set; }
        /** 捷顺 MC.LastBrushInfo.LastBrushCardTime（最后刷卡时间）。 */
        public string lastSwipeAt { get; set; }
        /** 捷顺 MC.Device.Name（最后刷卡出入口）。 */
        public string lastDevice { get; set; }
    }

    internal sealed class LegacyHistoryResult
    {
        public int issuedCount { get; set; }
        public int nextSequence { get; set; }
        public List<LegacyHistoryEntry> history { get; set; }
    }

    internal sealed class LegacyCardMatch
    {
        public long personId { get; set; }
        public string personNo { get; set; }
        public string personName { get; set; }
        public string icCardNo { get; set; }
        public string issuedAt { get; set; }
    }

    internal sealed class LegacyCardSyncResult
    {
        public long PersonId { get; set; }
        public string PersonNo { get; set; }
        public int HouseSequence { get; set; }
    }

    internal sealed class LegacySearchEntry
    {
        public long personId { get; set; }
        public string personNo { get; set; }
        public string personName { get; set; }
        public string icCardNo { get; set; }
        public string issuedAt { get; set; }
        public int sequence { get; set; }
        public string roomKey { get; set; }
    }

    internal sealed class LegacyProbeResult
    {
        public string serverVersion { get; set; }
        public string database { get; set; }
        public string loginUser { get; set; }
        public bool canReadPerson { get; set; }
        public bool canReadCardInfo { get; set; }
        public bool canInsertPerson { get; set; }
        public bool canInsertCardInfo { get; set; }
        public long personCount { get; set; }
        public long cardInfoCount { get; set; }
        public string error { get; set; }

        public bool CanWrite
        {
            get { return canInsertPerson && canInsertCardInfo; }
        }
    }

    internal sealed class LegacySchemaTable
    {
        public string schema { get; set; }
        public string table { get; set; }
    }

    internal sealed class LegacySchemaColumn
    {
        public string schema { get; set; }
        public string table { get; set; }
        public string column { get; set; }
        public string dataType { get; set; }
        public int? maxLength { get; set; }
        public bool nullable { get; set; }
        public int ordinal { get; set; }
    }

    /** .80 旧库只读诊断；正式同步会复用同一事务锁后再写 Person/CardInfo。 */
    internal static class LegacyDatabase
    {
        public static LegacyHistoryResult GetRecentCards(AgentConfig config, string password)
        {
            var result = new LegacyHistoryResult { issuedCount = 0, nextSequence = 31,
                history = new List<LegacyHistoryEntry>() };
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = @"SELECT TOP (30) c.[ID], c.[PersonID], p.[NO], p.[Name], p.[OptDate],
       c.[IDNO], c.[IssueDate], lb.[LastBrushCardTime], dev.[Name] AS LastBrushDeviceName
FROM [MC].[CardInfo] c
LEFT JOIN [HR].[Person] p ON p.[ID] = c.[PersonID]
OUTER APPLY (
    SELECT TOP 1 l.[LastBrushCardTime], l.[LastBrushCardDeviceId]
    FROM [MC].[LastBrushInfo] l WHERE l.[CardInfoID] = c.[ID]
    ORDER BY l.[LastBrushCardTime] DESC
) lb
LEFT JOIN [MC].[Device] dev ON dev.[ID] = lb.[LastBrushCardDeviceId]
WHERE c.[IDNO] IS NOT NULL AND LTRIM(RTRIM(c.[IDNO])) <> '' AND c.[IssueDate] IS NOT NULL
ORDER BY c.[IssueDate] DESC, c.[ID] DESC;";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) result.history.Add(new LegacyHistoryEntry {
                        personId = reader.IsDBNull(1) ? -Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture) : Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                        personNo = reader.IsDBNull(2) ? "" : Convert.ToString(reader.GetValue(2), CultureInfo.InvariantCulture).Trim(),
                        personName = reader.IsDBNull(3) ? "" : Convert.ToString(reader.GetValue(3), CultureInfo.InvariantCulture).Trim(),
                        sequence = result.history.Count + 1,
                        cardInfoId = reader.IsDBNull(0) ? (long?)null : Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture),
                        personCreatedAt = ReadDateText(reader, 4),
                        icCardNo = reader.IsDBNull(5) ? null : Convert.ToString(reader.GetValue(5), CultureInfo.InvariantCulture).Trim().ToUpperInvariant(),
                        issuedAt = ReadDateText(reader, 6),
                        lastSwipeAt = ReadDateText(reader, 7),
                        lastDevice = reader.IsDBNull(8) ? null : Convert.ToString(reader.GetValue(8), CultureInfo.InvariantCulture).Trim()
                    });
            }
            result.issuedCount = result.history.Count;
            return result;
        }
        public static LegacySequenceResult GetNextSequence(AgentConfig config, string password, string roomKey)
        {
            if (String.IsNullOrWhiteSpace(config.LegacySqlServer) ||
                String.IsNullOrWhiteSpace(config.LegacyDatabase) ||
                String.IsNullOrWhiteSpace(config.LegacyUser))
                throw new InvalidOperationException("旧库配置缺少 LegacySqlServer、LegacyDatabase 或 LegacyUser");
            if (String.IsNullOrWhiteSpace(roomKey)) throw new InvalidOperationException("房号不能为空");
            roomKey = NormalizeRoomKey(roomKey);

            var builder = new SqlConnectionStringBuilder
            {
                DataSource = config.LegacySqlServer,
                InitialCatalog = config.LegacyDatabase,
                UserID = config.LegacyUser,
                Password = password,
                ConnectTimeout = 5,
                Encrypt = false,
                TrustServerCertificate = true,
                ApplicationName = "PMS Access Card Legacy Sync"
            };
            using (var connection = new SqlConnection(builder.ConnectionString))
            {
                connection.Open();
                using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    // 旧库同一房号存在楼号前导零和“已隐藏”等前缀。
                    // SQL 先宽松取候选，随后 TrySequence 再逐段核对弄/楼/室，防止串户。
                    command.CommandText = @"
SELECT [Name]
FROM [HR].[Person] WITH (UPDLOCK, HOLDLOCK)
WHERE [Name] LIKE @candidate ESCAPE '\';";
                    command.Parameters.Add("@candidate", SqlDbType.NVarChar, 120).Value = CandidateLike(roomKey);
                    var count = 0;
                    var max = 0;
                    using (var reader = command.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            var name = reader.IsDBNull(0) ? "" : reader.GetString(0);
                            int sequence;
                            if (!TrySequence(roomKey, name, out sequence)) continue;
                            count++;
                            if (sequence > max) max = sequence;
                        }
                    }
                    transaction.Rollback(); // 诊断命令绝不写库
                    return new LegacySequenceResult
                    {
                        IssuedCount = count,
                        NextSequence = Math.Max(count, max) + 1
                    };
                }
            }
        }

        public static LegacyHistoryResult GetHistory(AgentConfig config, string password, string roomKey)
        {
            roomKey = NormalizeRoomKey(roomKey);
            var sequence = GetNextSequence(config, password, roomKey);
            var result = new LegacyHistoryResult
            {
                issuedCount = sequence.IssuedCount,
                nextSequence = sequence.NextSequence,
                history = new List<LegacyHistoryEntry>()
            };
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = @"
SELECT p.[ID], p.[NO], p.[Name], p.[OptDate], c.[ID], c.[IDNO], c.[IssueDate],
       lb.[LastBrushCardTime], dev.[Name] AS LastBrushDeviceName
FROM [HR].[Person] p
LEFT JOIN [MC].[CardInfo] c ON c.[PersonID] = p.[ID]
OUTER APPLY (
    SELECT TOP 1 l.[LastBrushCardTime], l.[LastBrushCardDeviceId]
    FROM [MC].[LastBrushInfo] l WHERE l.[CardInfoID] = c.[ID]
    ORDER BY l.[LastBrushCardTime] DESC
) lb
LEFT JOIN [MC].[Device] dev ON dev.[ID] = lb.[LastBrushCardDeviceId]
WHERE p.[Name] LIKE @candidate ESCAPE '\'
ORDER BY p.[ID] DESC;";
                command.Parameters.Add("@candidate", SqlDbType.NVarChar, 120).Value = CandidateLike(roomKey);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        int cardSequence;
                        var name = reader.IsDBNull(2) ? "" : reader.GetString(2);
                        if (!TrySequence(roomKey, name, out cardSequence)) continue;
                        result.history.Add(new LegacyHistoryEntry
                        {
                            personId = reader.GetInt64(0),
                            personNo = reader.IsDBNull(1) ? "" : reader.GetString(1),
                            sequence = cardSequence,
                            personName = name,
                            cardInfoId = reader.IsDBNull(4) ? (long?)null : Convert.ToInt64(reader.GetValue(4), CultureInfo.InvariantCulture),
                            icCardNo = reader.IsDBNull(5) ? null : reader.GetString(5).Trim().ToUpperInvariant(),
                            issuedAt = ReadDateText(reader, 6),
                            personCreatedAt = ReadDateText(reader, 3),
                            lastSwipeAt = ReadDateText(reader, 7),
                            lastDevice = reader.IsDBNull(8) ? null : Convert.ToString(reader.GetValue(8), CultureInfo.InvariantCulture).Trim()
                        });
                    }
                }
            }
            return result;
        }

        /** 写卡前全库查重；不能只查当前房号，否则旧卡换房会被漏掉。 */
        public static List<LegacyCardMatch> FindCard(AgentConfig config, string password, string icCardNo)
        {
            var normalized = (icCardNo ?? "").Replace(" ", "").Trim().ToUpperInvariant();
            if (normalized.Length < 6) throw new InvalidOperationException("IC 卡号无效");
            var matches = new List<LegacyCardMatch>();
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = @"
SELECT TOP (20) c.[ID], c.[PersonID], p.[NO], p.[Name], c.[IDNO], c.[IssueDate]
FROM [MC].[CardInfo] c
LEFT JOIN [HR].[Person] p ON p.[ID] = c.[PersonID]
WHERE UPPER(LTRIM(RTRIM(c.[IDNO]))) = @cardNo
ORDER BY c.[IssueDate] DESC, p.[ID] DESC;";
                command.Parameters.Add("@cardNo", SqlDbType.NVarChar, 40).Value = normalized;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        matches.Add(new LegacyCardMatch
                        {
                            personId = reader.IsDBNull(1) ? -Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture) : Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                            personNo = reader.IsDBNull(2) ? "" : reader.GetString(2).Trim(),
                            personName = reader.IsDBNull(3)
                                ? "原用户记录已删除（CardInfo ID " + Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture) + "）"
                                : reader.GetString(3).Trim(),
                            icCardNo = reader.IsDBNull(4) ? normalized : reader.GetString(4).Trim().ToUpperInvariant(),
                            issuedAt = reader.IsDBNull(5) ? null : reader.GetDateTime(5).ToString("o", CultureInfo.InvariantCulture)
                        });
                    }
                }
            }
            return matches;
        }

        /** 只读查找现库未占用的 ICNO；PMS 使用唯一索引保留，真正写库时再次查重。 */
        public static int FindAvailableIcNo(AgentConfig config, string password, IEnumerable<int> reservedIcNos)
        {
            var reserved = new HashSet<int>(reservedIcNos ?? new int[0]);
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = "SELECT [ICNO] FROM [MC].[CardInfo] WHERE [ICNO] IS NOT NULL";
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        int used;
                        if (Int32.TryParse(Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture).Trim(),
                            NumberStyles.None, CultureInfo.InvariantCulture, out used)) reserved.Add(used);
                    }
                }
                for (var candidate = 30500; candidate <= 65535; candidate++)
                    if (!reserved.Contains(candidate)) return candidate;
                throw new InvalidOperationException("捷顺数据库已无可分配 ICNO");
            }
        }

        public static LegacyCardSyncResult SyncIssuedCard(AgentConfig config, string password, AgentTask task)
        {
            if (!task.legacyIcNo.HasValue || String.IsNullOrWhiteSpace(task.icCardNo) || String.IsNullOrWhiteSpace(task.roomKey))
                throw new InvalidOperationException("捷顺入库任务缺少 ICNO、UID 或房号");
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            {
                connection.Open();
                using (var transaction = connection.BeginTransaction(IsolationLevel.Serializable))
                {
                    try
                    {
                        var roomKey = NormalizeRoomKey(task.roomKey);
                        using (var prior = connection.CreateCommand())
                        {
                            prior.Transaction = transaction;
                            prior.CommandText = @"SELECT TOP (1) c.IDNO,c.ICNO,p.ID,p.NO,p.Name
FROM MC.CardInfo c WITH (UPDLOCK,HOLDLOCK)
INNER JOIN HR.Person p WITH (UPDLOCK,HOLDLOCK) ON p.ID=c.PersonID
WHERE c.IDNO=@uid OR c.ICNO=@icno
ORDER BY c.ID DESC";
                            prior.Parameters.Add("@uid", SqlDbType.VarChar, 20).Value = task.icCardNo;
                            prior.Parameters.Add("@icno", SqlDbType.VarChar, 8).Value = task.legacyIcNo.Value.ToString(CultureInfo.InvariantCulture);
                            using (var reader = prior.ExecuteReader())
                            {
                                if (reader.Read())
                                {
                                    var storedUid = Convert.ToString(reader.GetValue(0), CultureInfo.InvariantCulture).Trim().ToUpperInvariant();
                                    var storedIcNo = Convert.ToString(reader.GetValue(1), CultureInfo.InvariantCulture).Trim();
                                    int storedSequence;
                                    if (!String.Equals(storedUid, task.icCardNo.Trim().ToUpperInvariant(), StringComparison.Ordinal) ||
                                        !String.Equals(storedIcNo, task.legacyIcNo.Value.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal) ||
                                        !TrySequence(roomKey, Convert.ToString(reader.GetValue(4), CultureInfo.InvariantCulture), out storedSequence))
                                        throw new InvalidOperationException("UID 或 ICNO 已被其他捷顺记录占用");
                                    var result = new LegacyCardSyncResult
                                    {
                                        PersonId = Convert.ToInt64(reader.GetValue(2), CultureInfo.InvariantCulture),
                                        PersonNo = Convert.ToString(reader.GetValue(3), CultureInfo.InvariantCulture).Trim(),
                                        HouseSequence = storedSequence
                                    };
                                    reader.Close();
                                    transaction.Commit();
                                    return result;
                                }
                            }
                        }
                        var houseSequence = 1;
                        using (var names = connection.CreateCommand())
                        {
                            names.Transaction = transaction;
                            names.CommandText = @"SELECT [Name] FROM [HR].[Person] WITH (UPDLOCK,HOLDLOCK) WHERE [Name] LIKE @candidate ESCAPE '\'";
                            names.Parameters.Add("@candidate", SqlDbType.NVarChar, 120).Value = CandidateLike(roomKey);
                            var count = 0;
                            var max = 0;
                            using (var reader = names.ExecuteReader())
                            {
                                while (reader.Read())
                                {
                                    int value;
                                    if (!TrySequence(roomKey, reader.IsDBNull(0) ? "" : reader.GetString(0), out value)) continue;
                                    count++;
                                    if (value > max) max = value;
                                }
                            }
                            houseSequence = Math.Max(count, max) + 1;
                        }
                        var displayName = roomKey + "/" + houseSequence.ToString(CultureInfo.InvariantCulture);
                        long personId;
                        string personNo;
                        using (var existing = connection.CreateCommand())
                        {
                            existing.Transaction = transaction;
                            existing.CommandText = @"SELECT TOP (1) p.ID,p.NO FROM HR.Person p WITH (UPDLOCK,HOLDLOCK) WHERE p.Name=@name ORDER BY p.ID DESC";
                            existing.Parameters.Add("@name", SqlDbType.NVarChar, 20).Value = displayName;
                            using (var reader = existing.ExecuteReader())
                            {
                                if (reader.Read()) { personId = Convert.ToInt64(reader.GetValue(0)); personNo = Convert.ToString(reader.GetValue(1)); }
                                else { personId = 0; personNo = null; }
                            }
                        }
                        if (personId == 0)
                        {
                            using (var next = connection.CreateCommand())
                            {
                                next.Transaction = transaction;
                                next.CommandText = "SELECT ID,NO FROM HR.Person WITH (UPDLOCK,HOLDLOCK)";
                                long maxId = 0;
                                long maxNo = 0;
                                using (var reader = next.ExecuteReader())
                                {
                                    while (reader.Read())
                                    {
                                        var id = Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
                                        if (id > maxId) maxId = id;
                                        long no;
                                        if (!reader.IsDBNull(1) && Int64.TryParse(Convert.ToString(reader.GetValue(1), CultureInfo.InvariantCulture).Trim(),
                                            NumberStyles.None, CultureInfo.InvariantCulture, out no) && no > maxNo) maxNo = no;
                                    }
                                }
                                personId = maxId + 1;
                                personNo = Convert.ToString(maxNo + 1, CultureInfo.InvariantCulture);
                            }
                            using (var insert = connection.CreateCommand())
                            {
                                insert.Transaction = transaction;
                                insert.CommandText = @"INSERT INTO HR.Person
(ID,SID,NO,Name,Sex,IDentityType,IdentityNO,Mobile,Tel1,Tel2,Email,RoomNO,Address,Photo,Job1ID,Job2ID,AreaID,DeptID,Remark,SystemDataFlag,DeleteFlag,ArchiveFlag,UploadFlag,ServerNO,ServerDown,PersonType,OptDate,TenementTypeNo,ToMasterRelationNo,LiveInHouseStateNo,CertificationTypeNo,PayTypeId,BirthAddr,Birthday)
VALUES(@id,1,@no,@name,1,N'0',N'',N'',N'',N'',N'',N'',N'',N'',0,0,0,1,N'',0,0,0,0,'0','0',0,GETDATE(),0,0,0,405,0,N'',CAST('2010-01-01' AS datetime))";
                                insert.Parameters.Add("@id", SqlDbType.BigInt).Value = personId;
                                insert.Parameters.Add("@no", SqlDbType.NVarChar, 10).Value = personNo;
                                insert.Parameters.Add("@name", SqlDbType.NVarChar, 20).Value = displayName;
                                insert.ExecuteNonQuery();
                            }
                        }
                        using (var duplicate = connection.CreateCommand())
                        {
                            duplicate.Transaction = transaction;
                            duplicate.CommandText = "SELECT ID,PersonID FROM MC.CardInfo WITH (UPDLOCK,HOLDLOCK) WHERE IDNO=@uid OR ICNO=@icno";
                            duplicate.Parameters.Add("@uid", SqlDbType.VarChar, 20).Value = task.icCardNo;
                            duplicate.Parameters.Add("@icno", SqlDbType.VarChar, 8).Value = task.legacyIcNo.Value.ToString(CultureInfo.InvariantCulture);
                            using (var reader = duplicate.ExecuteReader()) if (reader.Read())
                            {
                                if (Convert.ToInt64(reader.GetValue(1)) != personId) throw new InvalidOperationException("UID 或 ICNO 已被其他人员占用");
                                transaction.Commit(); return new LegacyCardSyncResult { PersonId = personId, PersonNo = personNo, HouseSequence = houseSequence };
                            }
                        }
                        long cardId;
                        using (var next = connection.CreateCommand()) { next.Transaction = transaction; next.CommandText = "SELECT ISNULL(MAX(ID),0)+1 FROM MC.CardInfo WITH (UPDLOCK,HOLDLOCK)"; cardId = Convert.ToInt64(next.ExecuteScalar()); }
                        using (var insert = connection.CreateCommand())
                        {
                            insert.Transaction = transaction;
                            insert.CommandText = @"INSERT INTO MC.CardInfo
(ID,SID,IDNO,ICNO,Status,PersonSID,PersonID,Deposit,UserID,OptDate,IssueDate,IssueOptons,Remark,ServerNO,ServerDown,Ver,IsPlan,MediaType,PhysicalCardType,VMAutoQuitDeviceName)
VALUES(@id,1,@uid,@icno,1,1,@personId,0,1,GETDATE(),GETDATE(),'01000000000000010000',N'PMS大铁门授权','00000000000000000000000000000000','00000000000000000000000000000000',0,0,1,55,NULL)";
                            insert.Parameters.Add("@id", SqlDbType.BigInt).Value = cardId; insert.Parameters.Add("@uid", SqlDbType.VarChar, 20).Value = task.icCardNo;
                            insert.Parameters.Add("@icno", SqlDbType.VarChar, 8).Value = task.legacyIcNo.Value.ToString(CultureInfo.InvariantCulture); insert.Parameters.Add("@personId", SqlDbType.BigInt).Value = personId;
                            insert.ExecuteNonQuery();
                        }
                        using (var verify = connection.CreateCommand()) { verify.Transaction = transaction; verify.CommandText = "SELECT COUNT(*) FROM MC.CardInfo WHERE IDNO=@uid AND ICNO=@icno AND PersonID=@personId AND Status=1"; verify.Parameters.Add("@uid", SqlDbType.VarChar, 20).Value = task.icCardNo; verify.Parameters.Add("@icno", SqlDbType.VarChar, 8).Value = task.legacyIcNo.Value.ToString(CultureInfo.InvariantCulture); verify.Parameters.Add("@personId", SqlDbType.BigInt).Value = personId; if (Convert.ToInt32(verify.ExecuteScalar()) != 1) throw new InvalidOperationException("捷顺卡记录写后回读失败"); }
                        transaction.Commit();
                        return new LegacyCardSyncResult { PersonId = personId, PersonNo = personNo, HouseSequence = houseSequence };
                    }
                    catch { transaction.Rollback(); throw; }
                }
            }
        }

        /**
         * .80 能力探测：只读查询 + SQL 权限函数，不写任何数据。
         * 用于把 legacyDbWrite 从「按代理身份写死」改成「数据库实际权限」。
         */
        public static LegacyProbeResult Probe(AgentConfig config, string password)
        {
            var result = new LegacyProbeResult();
            try
            {
                using (var connection = new SqlConnection(ConnectionString(config, password)))
                {
                    connection.Open();
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT @@VERSION";
                        result.serverVersion = Convert.ToString(command.ExecuteScalar());
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT DB_NAME()";
                        result.database = Convert.ToString(command.ExecuteScalar());
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT SUSER_SNAME()";
                        result.loginUser = Convert.ToString(command.ExecuteScalar());
                    }
                    result.canReadPerson = HasPermission(connection, "HR.Person", "SELECT");
                    result.canReadCardInfo = HasPermission(connection, "MC.CardInfo", "SELECT");
                    result.canInsertPerson = HasPermission(connection, "HR.Person", "INSERT");
                    result.canInsertCardInfo = HasPermission(connection, "MC.CardInfo", "INSERT");
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT COUNT(*) FROM HR.Person";
                        result.personCount = Convert.ToInt64(command.ExecuteScalar());
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.CommandText = "SELECT COUNT(*) FROM MC.CardInfo";
                        result.cardInfoCount = Convert.ToInt64(command.ExecuteScalar());
                    }
                }
            }
            catch (Exception exception)
            {
                result.error = exception.Message;
            }
            return result;
        }

        public static bool CanWrite(AgentConfig config, string password)
        {
            try
            {
                var probe = Probe(config, password);
                return String.IsNullOrEmpty(probe.error) && probe.CanWrite;
            }
            catch
            {
                return false;
            }
        }

        private static bool HasPermission(SqlConnection connection, string table, string action)
        {
            try
            {
                using (var command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT HAS_PERMS_BY_NAME(@table,'OBJECT',@action)";
                    command.Parameters.Add("@table", SqlDbType.NVarChar, 128).Value = table;
                    command.Parameters.Add("@action", SqlDbType.NVarChar, 128).Value = action;
                    var value = command.ExecuteScalar();
                    return value != null && value != DBNull.Value && Convert.ToInt32(value) == 1;
                }
            }
            catch
            {
                return false;
            }
        }

        /** .80 人员/卡按姓名、房号、卡号模糊查询；只读，最多 60 条。 */
        public static List<LegacySearchEntry> SearchCards(AgentConfig config, string password, string term)
        {
            term = (term ?? "").Trim();
            if (String.IsNullOrWhiteSpace(term)) throw new InvalidOperationException("查询词不能为空");
            var parts = term.Split('/');
            var candidate = parts.Length == 3 ? CandidateLike(term) : "%" + EscapeLike(term) + "%";
            var results = new List<LegacySearchEntry>();
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = @"
SELECT TOP (60) p.[ID], p.[NO], p.[Name], c.[IDNO], c.[IssueDate]
FROM [HR].[Person] p
LEFT JOIN [MC].[CardInfo] c ON c.[PersonID] = p.[ID]
WHERE p.[Name] LIKE @candidate ESCAPE '\' OR p.[NO] LIKE @candidate ESCAPE '\' OR c.[IDNO] LIKE @candidate ESCAPE '\'
ORDER BY p.[ID] DESC;";
                command.Parameters.Add("@candidate", SqlDbType.NVarChar, 120).Value = candidate;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var name = reader.IsDBNull(2) ? "" : reader.GetString(2);
                        int sequence;
                        var roomKey = parts.Length == 3 && TrySequence(term, name, out sequence)
                            ? NormalizeRoomKey(term) : null;
                        if (parts.Length == 3 && roomKey == null) continue;
                        results.Add(new LegacySearchEntry
                        {
                            personId = reader.GetInt64(0),
                            personNo = reader.IsDBNull(1) ? "" : reader.GetString(1),
                            personName = name,
                            icCardNo = reader.IsDBNull(3) ? null : reader.GetString(3).Trim().ToUpperInvariant(),
                            issuedAt = reader.IsDBNull(4) ? null : reader.GetDateTime(4).ToString("o", CultureInfo.InvariantCulture),
                            sequence = roomKey == null ? 0 : SequenceFromName(name),
                            roomKey = roomKey
                        });
                    }
                }
            }
            return results;
        }

        private static int SequenceFromName(string name)
        {
            var match = Regex.Match(name ?? "", @"(\d+)\s*$");
            int sequence;
            return match.Success && Int32.TryParse(match.Groups[1].Value, NumberStyles.None,
                CultureInfo.InvariantCulture, out sequence) ? sequence : 0;
        }

        /** .80 只读 schema 发现：先用 INFORMATION_SCHEMA 找表，再按表名取列。 */
        public static List<LegacySchemaTable> SchemaTables(AgentConfig config, string password)
        {
            var output = new List<LegacySchemaTable>();
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = @"SELECT TABLE_SCHEMA,TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA,TABLE_NAME";
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        output.Add(new LegacySchemaTable
                        {
                            schema = reader.GetString(0),
                            table = reader.GetString(1)
                        });
            }
            return output;
        }

        public static List<LegacySchemaColumn> SchemaColumns(AgentConfig config, string password, string table)
        {
            if (String.IsNullOrWhiteSpace(table)) throw new InvalidOperationException("表名不能为空");
            var output = new List<LegacySchemaColumn>();
            using (var connection = new SqlConnection(ConnectionString(config, password)))
            using (var command = connection.CreateCommand())
            {
                connection.Open();
                command.CommandText = @"SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,IS_NULLABLE,ORDINAL_POSITION
FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=@table ORDER BY ORDINAL_POSITION";
                command.Parameters.Add("@table", SqlDbType.NVarChar, 128).Value = table;
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        output.Add(new LegacySchemaColumn
                        {
                            schema = reader.GetString(0),
                            table = reader.GetString(1),
                            column = reader.GetString(2),
                            dataType = reader.GetString(3),
                            maxLength = reader.IsDBNull(4) ? (int?)null : Convert.ToInt32(reader.GetValue(4)),
                            nullable = String.Equals(reader.GetString(5), "YES", StringComparison.OrdinalIgnoreCase),
                            ordinal = Convert.ToInt32(reader.GetValue(6))
                        });
            }
            return output;
        }

        private static string ReadDateText(SqlDataReader reader, int index)
        {
            if (reader.IsDBNull(index)) return null;
            return Convert.ToDateTime(reader.GetValue(index), CultureInfo.InvariantCulture)
                .ToString("o", CultureInfo.InvariantCulture);
        }

        private static string ConnectionString(AgentConfig config, string password)
        {
            if (String.IsNullOrWhiteSpace(config.LegacySqlServer) ||
                String.IsNullOrWhiteSpace(config.LegacyDatabase) ||
                String.IsNullOrWhiteSpace(config.LegacyUser))
                throw new InvalidOperationException("旧库配置缺少 LegacySqlServer、LegacyDatabase 或 LegacyUser");
            return new SqlConnectionStringBuilder
            {
                DataSource = config.LegacySqlServer,
                InitialCatalog = config.LegacyDatabase,
                UserID = config.LegacyUser,
                Password = password,
                ConnectTimeout = 5,
                Encrypt = false,
                TrustServerCertificate = true,
                ApplicationName = "PMS Access Card Legacy Sync"
            }.ConnectionString;
        }

        internal static bool TrySequence(string roomKey, string name, out int sequence)
        {
            sequence = 0;
            roomKey = NormalizeRoomKey(roomKey);
            string lane;
            string building;
            string room;
            if (!TryRoomParts(roomKey, out lane, out building, out room)) return false;
            foreach (Match match in Regex.Matches(name ?? "", @"(?<!\d)(\d+)\s*[/／\\-]\s*(\d+)\s*[/／\\-]\s*(\d+)\s*[/／\\-]\s*(\d+)(?!\d)"))
            {
                if (!SameNumber(match.Groups[1].Value, lane) ||
                    !SameNumber(match.Groups[2].Value, building) ||
                    !SameNumber(match.Groups[3].Value, room)) continue;
                if (Int32.TryParse(match.Groups[4].Value, NumberStyles.None, CultureInfo.InvariantCulture, out sequence) && sequence > 0)
                    return true;
            }
            sequence = 0;
            return false;
        }

        internal static string NormalizeRoomKey(string roomKey)
        {
            var parts = roomKey.Split('/');
            int building;
            if (parts.Length == 3 && Int32.TryParse(parts[1], out building))
                parts[1] = building.ToString("00");
            return String.Join("/", parts);
        }

        private static string EscapeLike(string value)
        {
            return value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace("[", "\\[");
        }

        private static string CandidateLike(string roomKey)
        {
            string lane;
            string building;
            string room;
            if (!TryRoomParts(roomKey, out lane, out building, out room))
                throw new InvalidOperationException("房号格式无法识别：" + roomKey);
            // `%228/%/102/%` 同时覆盖 228/2/102、228/02/102 和前缀了“已隐藏”的历史名称。
            return "%" + EscapeLike(lane + "/") + "%" + EscapeLike("/" + room + "/") + "%";
        }

        private static bool TryRoomParts(string roomKey, out string lane, out string building, out string room)
        {
            lane = building = room = null;
            var parts = (roomKey ?? "").Split('/');
            if (parts.Length != 3) return false;
            lane = parts[0].Trim();
            building = parts[1].Trim();
            room = parts[2].Trim();
            return lane.Length > 0 && building.Length > 0 && room.Length > 0;
        }

        private static bool SameNumber(string left, string right)
        {
            long leftNumber;
            long rightNumber;
            return Int64.TryParse(left, NumberStyles.None, CultureInfo.InvariantCulture, out leftNumber) &&
                   Int64.TryParse(right, NumberStyles.None, CultureInfo.InvariantCulture, out rightNumber) &&
                   leftNumber == rightNumber;
        }
    }
}
