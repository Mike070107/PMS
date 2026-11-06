using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessQueryPermission
    {
        public string accessSystem { get; set; }
        public string buildingNo { get; set; }
        public string controller { get; set; }
        public string door { get; set; }
        public string sourceTable { get; set; }
    }

    internal sealed class AccessQueryCard
    {
        public string accessSystem { get; set; }
        public string cardNo { get; set; }
        public string personName { get; set; }
        public string personNo { get; set; }
        public string groupName { get; set; }
        public int sequence { get; set; }
        public string beginDate { get; set; }
        public string endDate { get; set; }
        public string status { get; set; }
        public string issueDate { get; set; }
        public string deadline { get; set; }
        public string lostDate { get; set; }
        public string deletedDate { get; set; }
        public string memo { get; set; }
        public List<AccessQueryPermission> permissions { get; set; }
        public AccessQueryCard()
        {
            permissions = new List<AccessQueryPermission>();
        }
    }

    internal sealed class AccessQueryRecord
    {
        public string accessSystem { get; set; }
        public string cardNo { get; set; }
        public string occurredAt { get; set; }
        public string door { get; set; }
        public string controller { get; set; }
        public string status { get; set; }
        public string reader { get; set; }
        public string sourceTable { get; set; }
    }

    internal sealed class AccessQueryGroup
    {
        public string accessSystem { get; set; }
        public int id { get; set; }
        public string name { get; set; }
        public string sourceTable { get; set; }
    }

    internal sealed class AccessQueryResult
    {
        public string term { get; set; }
        public string matchedBy { get; set; }
        public List<AccessQueryCard> cards { get; set; }
        public List<AccessQueryRecord> records { get; set; }
        public List<AccessQueryGroup> groups { get; set; }
        public List<string> errors { get; set; }
        public AccessQueryResult()
        {
            cards = new List<AccessQueryCard>();
            records = new List<AccessQueryRecord>();
            groups = new List<AccessQueryGroup>();
            errors = new List<string>();
        }
    }

    /**
     * .88 两套 Access MDB 的只读查询。
     * 所有 SQL 都是参数化固定语句；表名来自现场核对过的白名单，不接受外部 SQL。
     * iCCard 需要 MDB 密码；密码缺失时只返回该系统的错误，不影响 MjSystem 查询。
     */
    internal static class AccessDatabaseQuery
    {
        private const int MaxCards = 100;
        private const int MaxRecords = 50;

        public static AccessQueryResult Query(AgentConfig config, string password, string term)
        {
            term = (term ?? "").Trim();
            if (String.IsNullOrWhiteSpace(term)) throw new InvalidOperationException("查询词不能为空");
            if (IsCardNumber(term)) return QueryByCard(config, password, term);
            if (term.IndexOf('/') >= 0) return QueryByRoom(config, password, term);
            return QueryByName(config, password, term);
        }

        public static AccessQueryResult QueryByCard(AgentConfig config, string password, string cardNo)
        {
            var result = NewResult(cardNo, "cardNo");
            ForEachCardVariant(cardNo, delegate(string variant)
            {
                TryMjSystem(config, result, delegate(OleDbConnection connection)
                {
                    ReadMjCards(connection, variant, result.cards);
                    ReadMjRecords(connection, variant, result.records);
                });
                TryIcCard(config, password, result, delegate(OleDbConnection connection)
                {
                    ReadIcCards(connection, variant, result.cards);
                    ReadIcRecords(connection, variant, result.records);
                });
            });
            SortRecords(result);
            return result;
        }

        public static AccessQueryResult QueryByRoom(AgentConfig config, string password, string roomKey)
        {
            var result = NewResult(roomKey, "roomKey");
            Func<string, bool> matchesRoom = delegate(string name)
            {
                int sequence;
                return LegacyDatabase.TrySequence(roomKey, name, out sequence);
            };
            TryMjSystem(config, result, delegate(OleDbConnection connection)
            {
                foreach (var pair in ReadMjCardsByLike(connection, Like(roomKey)))
                {
                    if (!matchesRoom(pair.Value)) continue;
                    AddCardUnique(result.cards, new AccessQueryCard
                    {
                        accessSystem = "mjsystem", cardNo = pair.Key, personName = pair.Value
                    });
                }
            });
            TryIcCard(config, password, result, delegate(OleDbConnection connection)
            {
                foreach (var pair in ReadIcCardsByLike(connection, Like(roomKey)))
                {
                    if (!matchesRoom(pair.Value)) continue;
                    AddCardUnique(result.cards, new AccessQueryCard
                    {
                        accessSystem = "iccard", cardNo = pair.Key, personName = pair.Value
                    });
                }
            });
            FillCardDetails(config, password, result);
            SortRecords(result);
            return result;
        }

        public static AccessQueryResult QueryByName(AgentConfig config, string password, string name)
        {
            var result = NewResult(name, "name");
            TryMjSystem(config, result, delegate(OleDbConnection connection)
            {
                foreach (var pair in ReadMjCardsByLike(connection, Like(name)))
                    AddCardUnique(result.cards, new AccessQueryCard
                    {
                        accessSystem = "mjsystem", cardNo = pair.Key, personName = pair.Value
                    });
            });
            TryIcCard(config, password, result, delegate(OleDbConnection connection)
            {
                foreach (var pair in ReadIcCardsByLike(connection, Like(name)))
                    AddCardUnique(result.cards, new AccessQueryCard
                    {
                        accessSystem = "iccard", cardNo = pair.Key, personName = pair.Value
                    });
            });
            FillCardDetails(config, password, result);
            SortRecords(result);
            return result;
        }

        /** 房号/姓名查询先拿到卡号，再按卡号补齐人员状态、权限和最近通行记录。 */
        private static void FillCardDetails(AgentConfig config, string password, AccessQueryResult result)
        {
            var detailed = new List<AccessQueryCard>();
            foreach (var card in result.cards.ToArray())
            {
                var detail = QueryByCard(config, password, card.cardNo);
                foreach (var item in detail.cards)
                {
                    if (item.accessSystem != card.accessSystem || !SameCard(item.cardNo, card.cardNo)) continue;
                    detailed.Add(item);
                }
                result.records.AddRange(detail.records);
                result.errors.AddRange(detail.errors.Where(message => !result.errors.Contains(message)));
            }
            result.cards = detailed
                .GroupBy(item => item.accessSystem + "\u0000" + item.cardNo)
                .Select(group => group.First())
                .ToList();
        }

        public static List<AccessQueryRecord> RecentRecords(AgentConfig config, string password, string cardNo)
        {
            var result = QueryByCard(config, password, cardNo);
            if (result.cards.Count == 0 && result.errors.Count > 0)
                throw new InvalidOperationException(String.Join("；", result.errors.ToArray()));
            return result.records;
        }

        public static List<AccessQueryGroup> Groups(AgentConfig config, string password)
        {
            var result = NewResult(null, "groups");
            TryMjSystem(config, result, delegate(OleDbConnection connection)
            {
                result.groups.AddRange(ReadMjGroups(connection));
            });
            TryIcCard(config, password, result, delegate(OleDbConnection connection)
            {
                result.groups.AddRange(ReadIcGroups(connection));
            });
            if (result.groups.Count == 0 && result.errors.Count > 0)
                throw new InvalidOperationException(String.Join("；", result.errors.ToArray()));
            return result.groups;
        }

        private static AccessQueryResult NewResult(string term, string matchedBy)
        {
            return new AccessQueryResult { term = term, matchedBy = matchedBy };
        }

        private static void ForEachCardVariant(string cardNo, Action<string> action)
        {
            foreach (var variant in CardVariants(cardNo)) action(variant);
        }

        internal static string[] CardVariants(string cardNo)
        {
            var normalized = (cardNo ?? "").Replace(" ", "").Trim().ToUpperInvariant();
            var values = new List<string> { normalized };
            if (Regex.IsMatch(normalized, "^[0-9]+$"))
            {
                if (normalized.Length < 8) values.Add(normalized.PadLeft(8, '0'));
                if (normalized.Length > 1 && normalized.StartsWith("0"))
                {
                    var trimmed = normalized.TrimStart('0');
                    if (trimmed.Length > 0) values.Add(trimmed);
                }
            }
            return values.Where(value => !String.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static bool IsCardNumber(string term)
        {
            var normalized = (term ?? "").Replace(" ", "").Trim();
            return Regex.IsMatch(normalized, "^[0-9A-Fa-f]{6,}$");
        }

        private static bool SameCard(string left, string right)
        {
            var a = (left ?? "").Trim().TrimStart('0');
            var b = (right ?? "").Trim().TrimStart('0');
            return String.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        private static void AddCardUnique(List<AccessQueryCard> cards, AccessQueryCard card)
        {
            foreach (var current in cards)
            {
                if (current.accessSystem == card.accessSystem && SameCard(current.cardNo, card.cardNo)) return;
            }
            if (cards.Count < MaxCards) cards.Add(card);
        }

        private static void SortRecords(AccessQueryResult result)
        {
            result.errors = result.errors.Distinct().ToList();
            result.records = result.records
                .GroupBy(item => String.Join("\u0000", new[] { item.accessSystem, item.cardNo, item.occurredAt, item.door, item.sourceTable }))
                .Select(group => group.First())
                .OrderByDescending(item => ParseTime(item.occurredAt))
                .Take(MaxRecords)
                .ToList();
            result.cards = result.cards
                .GroupBy(item => item.accessSystem + "\u0000" + item.cardNo)
                .Select(group => group.First())
                .OrderBy(item => item.accessSystem)
                .ThenBy(item => item.personName)
                .ToList();
        }

        private static DateTime ParseTime(string value)
        {
            DateTime parsed;
            return DateTime.TryParse(value, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out parsed)
                ? parsed : DateTime.MinValue;
        }

        private static void TryMjSystem(AgentConfig config, AccessQueryResult result, Action<OleDbConnection> action)
        {
            try
            {
                using (var connection = Open(config.MjSystemDatabasePath, null, "MjSystem"))
                    action(connection);
            }
            catch (Exception exception)
            {
                result.errors.Add("MjSystem：" + exception.Message);
            }
        }

        private static void TryIcCard(AgentConfig config, string password, AccessQueryResult result, Action<OleDbConnection> action)
        {
            try
            {
                using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
                    action(connection);
            }
            catch (Exception exception)
            {
                result.errors.Add("iCCard：" + (String.IsNullOrEmpty(password)
                    ? "打开失败（请先在 .88 本机执行 --install-iccard-password 保存 MDB 密码）：" + exception.Message
                    : exception.Message));
            }
        }

        private static OleDbConnection Open(string path, string password, string name)
        {
            return AccessOleDb.Open(path, password, name);
        }

        private static string Like(string value)
        {
            // Jet/Access SQL 不支持 T-SQL 的 ESCAPE 子句；这里只接受房号/姓名，出现通配符直接拒绝。
            var text = value ?? "";
            if (text.IndexOf('%') >= 0 || text.IndexOf('_') >= 0 || text.IndexOf('[') >= 0)
                throw new InvalidOperationException("查询词不能包含 % _ [ 等通配符");
            return "%" + text + "%";
        }

        private static string Text(OleDbDataReader reader, string field)
        {
            try
            {
                var value = reader[field];
                return value == null || value == DBNull.Value ? "" : Convert.ToString(value).Trim();
            }
            catch { return ""; }
        }

        private static string TimeText(OleDbDataReader reader, string field)
        {
            try
            {
                var value = reader[field];
                if (value == null || value == DBNull.Value) return null;
                return Convert.ToDateTime(value, CultureInfo.InvariantCulture).ToString("o", CultureInfo.InvariantCulture);
            }
            catch { return null; }
        }

        private static void ReadMjCards(OleDbConnection connection, string cardNo, List<AccessQueryCard> output)
        {
            const string sql = "SELECT EId,vEmp_id,vEmp_name,vCardNo,vDepart,dBeginDate,dEndDate,EmpMemo " +
                "FROM Employee WHERE vCardNo=?";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var name = Text(reader, "vEmp_name");
                        output.Add(new AccessQueryCard
                        {
                            accessSystem = "mjsystem",
                            cardNo = Text(reader, "vCardNo"),
                            personName = name,
                            personNo = Text(reader, "vEmp_id"),
                            groupName = Text(reader, "vDepart"),
                            sequence = SequenceOf(name),
                            beginDate = TimeText(reader, "dBeginDate"),
                            endDate = TimeText(reader, "dEndDate"),
                            memo = Text(reader, "EmpMemo"),
                            permissions = ReadMjPermissions(connection, Text(reader, "vCardNo"))
                        });
                    }
                }
            }
        }

        private static int SequenceOf(string personName)
        {
            var match = Regex.Match(personName ?? "", @"(\d+)\s*$");
            int sequence;
            return match.Success && Int32.TryParse(match.Groups[1].Value, NumberStyles.None,
                CultureInfo.InvariantCulture, out sequence) ? sequence : 0;
        }

        private static List<AccessQueryPermission> ReadMjPermissions(OleDbConnection connection, string cardNo)
        {
            var output = new List<AccessQueryPermission>();
            const string sql = "SELECT P.cDoorId,D.vDoorName,M.vExposition " +
                "FROM (MJ_MacPower AS P LEFT JOIN MJ_DoorInfo AS D ON P.cDoorId=D.cDoorId) " +
                "LEFT JOIN MJ_MacInfo AS M ON D.cMacId=M.cMacId WHERE P.cCardNo=?";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var door = Text(reader, "vDoorName");
                        var controller = Text(reader, "vExposition");
                        output.Add(new AccessQueryPermission
                        {
                            accessSystem = "mjsystem",
                            buildingNo = AccessGatewayDatabase.ExtractBuildingNo(door, controller),
                            controller = String.IsNullOrWhiteSpace(controller) ? null : controller,
                            door = String.IsNullOrWhiteSpace(door) ? Text(reader, "cDoorId") : door,
                            sourceTable = "MJ_MacPower"
                        });
                    }
                }
            }
            return output;
        }

        private static void ReadMjRecords(OleDbConnection connection, string cardNo, List<AccessQueryRecord> output)
        {
            const string sql = "SELECT TOP 50 cCardNo,dTime,cDoorId,cStatus,vStatusType " +
                "FROM MJ_MacRecord WHERE cCardNo=? ORDER BY dTime DESC";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        output.Add(new AccessQueryRecord
                        {
                            accessSystem = "mjsystem",
                            cardNo = Text(reader, "cCardNo"),
                            occurredAt = TimeText(reader, "dTime"),
                            door = Text(reader, "cDoorId"),
                            status = Text(reader, "cStatus"),
                            reader = Text(reader, "vStatusType"),
                            sourceTable = "MJ_MacRecord"
                        });
                    }
                }
            }
        }

        private static List<KeyValuePair<string, string>> ReadMjCardsByLike(OleDbConnection connection, string like)
        {
            var output = new List<KeyValuePair<string, string>>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT TOP 100 vCardNo,vEmp_name FROM Employee WHERE vEmp_name LIKE ?";
                command.Parameters.AddWithValue("@like", like);
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        output.Add(new KeyValuePair<string, string>(Text(reader, "vCardNo"), Text(reader, "vEmp_name")));
            }
            return output;
        }

        private static List<AccessQueryGroup> ReadMjGroups(OleDbConnection connection)
        {
            var output = new List<AccessQueryGroup>();
            // PowerHeader 是 MjSystem 的“功能/操作权限”菜单，不是门禁卡的授权方案，不能当权限组返回。
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT cID,vName FROM MJ_MacTime";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) output.Add(new AccessQueryGroup
                    {
                        accessSystem = "mjsystem",
                        id = Convert.ToInt32(reader["cID"]),
                        name = Text(reader, "vName"),
                        sourceTable = "MJ_MacTime"
                    });
            }
            return output;
        }

        private static void ReadIcCards(OleDbConnection connection, string cardNo, List<AccessQueryCard> output)
        {
            const string sql = "SELECT C.f_ConsumerID,C.f_ConsumerNO,C.f_ConsumerName,C.f_GroupID,G.f_GroupName," +
                "C.f_BeginYMD,C.f_EndYMD,I.f_CardID,I.f_CardNO,I.f_CardStatusDesc,I.f_IssueDate," +
                "I.f_Deadline,I.f_LostDate,I.f_DeletedDate " +
                "FROM (t_b_IDCard AS I LEFT JOIN t_b_Consumer AS C ON I.f_ConsumerID=C.f_ConsumerID) " +
                "LEFT JOIN t_b_Group AS G ON C.f_GroupID=G.f_GroupID WHERE I.f_CardNO=?";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var consumerId = reader["f_ConsumerID"] == DBNull.Value ? 0 : Convert.ToInt32(reader["f_ConsumerID"]);
                        var name = Text(reader, "f_ConsumerName");
                        output.Add(new AccessQueryCard
                        {
                            accessSystem = "iccard",
                            cardNo = Text(reader, "f_CardNO"),
                            personName = name,
                            personNo = Text(reader, "f_ConsumerNO"),
                            groupName = Text(reader, "f_GroupName"),
                            sequence = SequenceOf(name),
                            beginDate = TimeText(reader, "f_BeginYMD"),
                            endDate = TimeText(reader, "f_EndYMD"),
                            status = Text(reader, "f_CardStatusDesc"),
                            issueDate = TimeText(reader, "f_IssueDate"),
                            deadline = TimeText(reader, "f_Deadline"),
                            lostDate = TimeText(reader, "f_LostDate"),
                            deletedDate = TimeText(reader, "f_DeletedDate"),
                            permissions = consumerId == 0
                                ? new List<AccessQueryPermission>()
                                : ReadIcPermissions(connection, consumerId)
                        });
                    }
                }
            }
        }

        private static List<AccessQueryPermission> ReadIcPermissions(OleDbConnection connection, int consumerId)
        {
            var output = new List<AccessQueryPermission>();
            const string sql = "SELECT P.f_DoorID,D.f_DoorName,C.f_ControllerName " +
                "FROM (t_d_Privilege AS P INNER JOIN t_b_Door AS D ON P.f_DoorID=D.f_DoorID) " +
                "LEFT JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID WHERE P.f_ConsumerID=?";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@consumer", consumerId);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var door = Text(reader, "f_DoorName");
                        var controller = Text(reader, "f_ControllerName");
                        output.Add(new AccessQueryPermission
                        {
                            accessSystem = "iccard",
                            buildingNo = AccessGatewayDatabase.ExtractBuildingNo(door, controller),
                            controller = String.IsNullOrWhiteSpace(controller) ? null : controller,
                            door = door,
                            sourceTable = "t_d_Privilege"
                        });
                    }
                }
            }
            return output;
        }

        private static void ReadIcRecords(OleDbConnection connection, string cardNo, List<AccessQueryRecord> output)
        {
            const string sql = "SELECT TOP 50 f_CardNO,f_ReadDate,f_Character,f_ControllerSN,f_ReaderID,f_Note,f_WarnType " +
                "FROM t_d_CardRecord WHERE f_CardNO=? ORDER BY f_ReadDate DESC";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        output.Add(new AccessQueryRecord
                        {
                            accessSystem = "iccard",
                            cardNo = Text(reader, "f_CardNO"),
                            occurredAt = TimeText(reader, "f_ReadDate"),
                            controller = Text(reader, "f_ControllerSN"),
                            reader = Text(reader, "f_ReaderID"),
                            status = Text(reader, "f_Character"),
                            sourceTable = "t_d_CardRecord"
                        });
                    }
                }
            }
        }

        private static List<KeyValuePair<string, string>> ReadIcCardsByLike(OleDbConnection connection, string like)
        {
            var output = new List<KeyValuePair<string, string>>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT TOP 100 I.f_CardNO,C.f_ConsumerName FROM t_b_IDCard AS I " +
                    "LEFT JOIN t_b_Consumer AS C ON I.f_ConsumerID=C.f_ConsumerID " +
                    "WHERE C.f_ConsumerName LIKE ?";
                command.Parameters.AddWithValue("@like", like);
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        output.Add(new KeyValuePair<string, string>(Text(reader, "f_CardNO"), Text(reader, "f_ConsumerName")));
            }
            return output;
        }

        private static List<AccessQueryGroup> ReadIcGroups(OleDbConnection connection)
        {
            var output = new List<AccessQueryGroup>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT f_GroupID,f_GroupName,f_Notes FROM t_b_Group";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) output.Add(new AccessQueryGroup
                    {
                        accessSystem = "iccard",
                        id = Convert.ToInt32(reader["f_GroupID"]),
                        name = Text(reader, "f_GroupName"),
                        sourceTable = "t_b_Group"
                    });
            }
            return output;
        }
    }
}
