using System;
using System.Data;
using System.Data.SqlClient;
using System.Collections.Generic;
using System.Globalization;

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
    }

    internal sealed class LegacyHistoryResult
    {
        public int issuedCount { get; set; }
        public int nextSequence { get; set; }
        public List<LegacyHistoryEntry> history { get; set; }
    }

    /** .80 旧库只读诊断；正式同步会复用同一事务锁后再写 Person/CardInfo。 */
    internal static class LegacyDatabase
    {
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
                    // 只取精确 `房号/数字`，不能沿用旧 PHP 的 `%房号%` 模糊匹配。
                    command.CommandText = @"
SELECT [Name]
FROM [HR].[Person] WITH (UPDLOCK, HOLDLOCK)
WHERE [Name] LIKE @prefix ESCAPE '\';";
                    command.Parameters.Add("@prefix", SqlDbType.NVarChar, 120).Value = EscapeLike(roomKey + "/") + "%";
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
WHERE p.[Name] LIKE @prefix ESCAPE '\'
ORDER BY p.[ID] DESC;";
                command.Parameters.Add("@prefix", SqlDbType.NVarChar, 120).Value = EscapeLike(roomKey + "/") + "%";
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
            var prefix = roomKey + "/";
            if (!name.StartsWith(prefix, StringComparison.Ordinal)) return false;
            return Int32.TryParse(name.Substring(prefix.Length), out sequence) && sequence > 0;
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
    }
}
