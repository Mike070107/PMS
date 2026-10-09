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
                command.CommandText = @"SELECT TOP (30) c.[ID], c.[PersonID], p.[NO], p.[Name], c.[IDNO], c.[IssueDate]
FROM [MC].[CardInfo] c LEFT JOIN [HR].[Person] p ON p.[ID] = c.[PersonID]
WHERE c.[IDNO] IS NOT NULL AND LTRIM(RTRIM(c.[IDNO])) <> '' AND c.[IssueDate] IS NOT NULL
ORDER BY c.[IssueDate] DESC, c.[ID] DESC;";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) result.history.Add(new LegacyHistoryEntry {
                        personId = reader.IsDBNull(1) ? -Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture) : Convert.ToInt64(reader.GetValue(1), CultureInfo.InvariantCulture),
                        personNo = reader.IsDBNull(2) ? "" : Convert.ToString(reader.GetValue(2), CultureInfo.InvariantCulture).Trim(),
                        personName = reader.IsDBNull(3) ? "" : Convert.ToString(reader.GetValue(3), CultureInfo.InvariantCulture).Trim(),
                        sequence = result.history.Count + 1,
                        icCardNo = reader.IsDBNull(4) ? null : Convert.ToString(reader.GetValue(4), CultureInfo.InvariantCulture).Trim().ToUpperInvariant(),
                        issuedAt = reader.GetDateTime(5).ToString("o", CultureInfo.InvariantCulture)
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
SELECT p.[ID], p.[NO], p.[Name], c.[IDNO], c.[IssueDate]
FROM [HR].[Person] p
LEFT JOIN [MC].[CardInfo] c ON c.[PersonID] = p.[ID]
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
                            icCardNo = reader.IsDBNull(3) ? null : reader.GetString(3).Trim().ToUpperInvariant(),
                            issuedAt = reader.IsDBNull(4) ? null : reader.GetDateTime(4).ToString("o", CultureInfo.InvariantCulture)
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
