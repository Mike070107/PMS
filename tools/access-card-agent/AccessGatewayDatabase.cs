using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessDatabaseProbeResult
    {
        public string Name { get; set; }
        public string Path { get; set; }
        public long Length { get; set; }
        public Dictionary<string, int> Counts { get; set; }
    }

    internal sealed class AccessDatabaseWriteResult
    {
        public int buildingId { get; set; }
        public string buildingNo { get; set; }
        public string accessSystem { get; set; }
        public string status { get; set; }
        public string databaseRecord { get; set; }
        public int? groupId { get; set; }
        public string groupName { get; set; }
        public string[] doors { get; set; }
    }

    internal sealed class IcCardGroupCandidate
    {
        public int Id { get; set; }
        public string Name { get; set; }
    }

    internal sealed class AccessPermissionResult
    {
        public string wgCardNo { get; set; }
        public string accessSystem { get; set; }
        public string buildingNo { get; set; }
        public string controller { get; set; }
        public string door { get; set; }
        public string sourceTable { get; set; }
    }

    /** .88 门禁数据库探测和受控幂等写入。 */
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

        public static object[] Activate(AgentConfig config, string password, AgentTask task)
        {
            if (task == null) throw new ArgumentNullException("task");
            if (String.IsNullOrWhiteSpace(task.wgCardNo) || !task.wgCardNo.All(Char.IsDigit) || task.wgCardNo.Length != 8)
                throw new InvalidOperationException("WG 卡号必须是 8 位数字");
            if (task.targetBuildings == null || task.targetBuildings.Length == 0)
                throw new InvalidOperationException("任务没有携带目标楼栋快照，请升级 PMS API");

            var results = new List<object>();
            var mjTargets = task.targetBuildings.Where(item => item.accessSystem == "mjsystem").ToArray();
            var icTargets = task.targetBuildings.Where(item => item.accessSystem == "iccard").ToArray();
            if (mjTargets.Length > 0) results.AddRange(ActivateMjSystem(config, task, mjTargets));
            if (icTargets.Length > 0) results.AddRange(ActivateIcCard(config, password, task, icTargets));
            if (results.Count != task.targetBuildings.Length)
                throw new InvalidOperationException("存在未配置门禁系统的目标楼栋");
            return results.ToArray();
        }

        /** 只读核验历史卡在两套楼栋门禁数据库中的实际门权限。 */
        public static AccessPermissionResult[] FindPermissions(
            AgentConfig config,
            string password,
            AccessPermissionTaskCard[] cards)
        {
            var results = new List<AccessPermissionResult>();
            var requested = (cards ?? new AccessPermissionTaskCard[0])
                .Where(item => item != null && !String.IsNullOrWhiteSpace(item.wgCardNo))
                .Select(item => item.wgCardNo.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            if (requested.Length == 0) return results.ToArray();

            using (var connection = Open(config.MjSystemDatabasePath, null, "MjSystem"))
            {
                foreach (var cardNo in requested)
                    ReadMjPermissions(connection, cardNo, results);
            }
            using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
            {
                foreach (var cardNo in requested)
                    ReadIcCardPermissions(connection, cardNo, results);
            }
            return results
                .GroupBy(item => String.Join("\u0000", new[] {
                    item.wgCardNo, item.accessSystem, item.controller, item.door
                }), StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .ToArray();
        }

        private static void ReadMjPermissions(
            OleDbConnection connection,
            string cardNo,
            List<AccessPermissionResult> output)
        {
            const string sql =
                "SELECT P.cCardNo,P.cDoorId,D.vDoorName,M.vExposition " +
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
                        var doorId = Text(reader, "cDoorId");
                        var doorName = Text(reader, "vDoorName");
                        var controller = Text(reader, "vExposition");
                        output.Add(new AccessPermissionResult
                        {
                            wgCardNo = cardNo,
                            accessSystem = "mjsystem",
                            buildingNo = ExtractBuildingNo(doorName, controller),
                            controller = EmptyToNull(controller),
                            door = String.IsNullOrWhiteSpace(doorName) ? doorId : doorName,
                            sourceTable = "MJ_MacPower"
                        });
                    }
                }
            }
        }

        private static void ReadIcCardPermissions(
            OleDbConnection connection,
            string cardNo,
            List<AccessPermissionResult> output)
        {
            const string sql =
                "SELECT I.f_CardNO,D.f_DoorName,C.f_ControllerName " +
                "FROM (((t_b_IDCard AS I INNER JOIN t_b_Consumer AS U ON I.f_ConsumerID=U.f_ConsumerID) " +
                "INNER JOIN t_d_Privilege AS P ON U.f_ConsumerID=P.f_ConsumerID) " +
                "INNER JOIN t_b_Door AS D ON P.f_DoorID=D.f_DoorID) " +
                "INNER JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID " +
                "WHERE I.f_CardNO=?";
            using (var command = connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Parameters.AddWithValue("@card", cardNo);
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var doorName = Text(reader, "f_DoorName");
                        var controller = Text(reader, "f_ControllerName");
                        output.Add(new AccessPermissionResult
                        {
                            wgCardNo = cardNo,
                            accessSystem = "iccard",
                            buildingNo = ExtractBuildingNo(doorName, controller),
                            controller = EmptyToNull(controller),
                            door = doorName,
                            sourceTable = "t_d_Privilege"
                        });
                    }
                }
            }
        }

        private static string Text(OleDbDataReader reader, string field)
        {
            var value = reader[field];
            return value == null || value == DBNull.Value ? "" : Convert.ToString(value).Trim();
        }

        private static string EmptyToNull(string value)
        {
            return String.IsNullOrWhiteSpace(value) ? null : value;
        }

        private static string UserDisplayName(AgentTask task)
        {
            return String.IsNullOrWhiteSpace(task.displayName) ? task.address : task.displayName.Trim();
        }

        private static string ExtractBuildingNo(params string[] values)
        {
            foreach (var value in values)
            {
                if (String.IsNullOrWhiteSpace(value)) continue;
                var match = Regex.Match(value, @"(?<!\d)(\d{1,3})\s*(?:号|#)?(?:楼|幢|栋|大门)", RegexOptions.IgnoreCase);
                if (!match.Success) continue;
                var normalized = match.Groups[1].Value.TrimStart('0');
                return normalized.Length == 0 ? "0" : normalized;
            }
            return null;
        }

        private static IEnumerable<object> ActivateMjSystem(AgentConfig config, AgentTask task, AccessTargetBuilding[] targets)
        {
            var connection = Open(config.MjSystemDatabasePath, null, "MjSystem");
            using (connection)
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    var isExistingCardGrant = String.Equals(task.action, "authorize_existing_card", StringComparison.OrdinalIgnoreCase);
                    var marker = isExistingCardGrant ? "PMS_AUTH_" + task.taskId : "PMS_ITEM_" + task.itemId;
                    var employeeId = ScalarInt(connection, transaction,
                        "SELECT EId FROM Employee WHERE vCardNo=?", task.wgCardNo);
                    if (employeeId.HasValue)
                    {
                        var memo = ScalarString(connection, transaction,
                            "SELECT EmpMemo FROM Employee WHERE EId=?", employeeId.Value);
                        if (!isExistingCardGrant && !String.Equals(memo, marker, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("WG 卡号已存在 MjSystem，但不属于当前 PMS 任务");
                        Execute(connection, transaction,
                            "UPDATE Employee SET vEmp_name=? WHERE EId=?",
                            Limit(UserDisplayName(task), 50), employeeId.Value);
                    }
                    else
                    {
                        Execute(connection, transaction,
                            "INSERT INTO Employee (vEmp_id,vEmp_name,vCardNo,vDepart,vDoorPassword,dBeginDate,dEndDate,EmpMemo,bWorkAttend) VALUES (?,?,?,?,?,?,?,?,?)",
                            isExistingCardGrant ? "A" + task.taskId : "P" + task.itemId,
                            Limit(UserDisplayName(task), 50), task.wgCardNo, "PMS 门禁发卡", "000000",
                            DateTime.Today, new DateTime(2099, 12, 31), marker, true);
                        employeeId = Convert.ToInt32(Scalar(connection, transaction, "SELECT @@IDENTITY"));
                    }

                    var output = new List<object>();
                    foreach (var target in targets)
                    {
                        var doors = MjDoors(connection, transaction, target.buildingNo);
                        foreach (var door in doors)
                        {
                            if (!ScalarInt(connection, transaction,
                                "SELECT COUNT(*) FROM MJ_MacPower WHERE cCardNo=? AND cDoorId=?", task.wgCardNo, door).HasValue)
                                throw new InvalidOperationException("MjSystem 权限查询失败");
                            var count = Convert.ToInt32(Scalar(connection, transaction,
                                "SELECT COUNT(*) FROM MJ_MacPower WHERE cCardNo=? AND cDoorId=?", task.wgCardNo, door));
                            if (count == 0)
                                Execute(connection, transaction,
                                    "INSERT INTO MJ_MacPower (cCardNo,cDoorId,cTimeId) VALUES (?,?,?)", task.wgCardNo, door, 1);
                        }
                        output.Add(new AccessDatabaseWriteResult
                        {
                            buildingId = target.id,
                            buildingNo = target.buildingNo,
                            accessSystem = "mjsystem",
                            status = "access_db_written",
                            databaseRecord = "Employee EId=" + employeeId.Value,
                            doors = doors
                        });
                    }
                    transaction.Commit();
                    return output;
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static IEnumerable<object> ActivateIcCard(AgentConfig config, string password, AgentTask task, AccessTargetBuilding[] targets)
        {
            var connection = Open(config.IcCardDatabasePath, password, "iCCard");
            using (connection)
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    var homeBuildingNo = ExtractRoomBuildingNo(UserDisplayName(task));
                    if (String.IsNullOrWhiteSpace(homeBuildingNo))
                        throw new InvalidOperationException("无法从用户姓名解析本楼栋，必须使用“弄号/楼栋/房号/序号”格式");
                    var group = ResolveIcCardGroup(connection, transaction, homeBuildingNo);
                    var isExistingCardGrant = String.Equals(task.action, "authorize_existing_card", StringComparison.OrdinalIgnoreCase);
                    var marker = isExistingCardGrant ? "PMS_AUTH_" + task.taskId : "PMS_ITEM_" + task.itemId;
                    var consumerId = ScalarInt(connection, transaction,
                        "SELECT f_ConsumerID FROM t_b_IDCard WHERE f_CardNO=?", task.wgCardNo);
                    if (consumerId.HasValue)
                    {
                        var note = ScalarString(connection, transaction,
                            "SELECT f_Note FROM t_b_Consumer WHERE f_ConsumerID=?", consumerId.Value);
                        if (!isExistingCardGrant && !String.Equals(note, marker, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("WG 卡号已存在 iCCard，但不属于当前 PMS 任务");
                        Execute(connection, transaction,
                            "UPDATE t_b_Consumer SET f_ConsumerName=?,f_GroupID=? WHERE f_ConsumerID=?",
                            Limit(UserDisplayName(task), 50), group.Id, consumerId.Value);
                    }
                    else
                    {
                        var nextNo = Convert.ToInt32(Scalar(connection, transaction,
                            "SELECT MAX(f_ConsumerNO) FROM t_b_Consumer")) + 1;
                        Execute(connection, transaction,
                            "INSERT INTO t_b_Consumer (f_ConsumerNO,f_ConsumerName,f_ConsumerGrade,f_GroupID,f_AttendEnabled,f_DoorEnabled,f_BeginYMD,f_EndYMD,f_Note,f_PatrolEnabled,f_bShift) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            nextNo, Limit(UserDisplayName(task), 50), "0", group.Id, 1, 1, DateTime.Today,
                            new DateTime(2099, 12, 31), marker, 0, 0);
                        consumerId = Convert.ToInt32(Scalar(connection, transaction, "SELECT @@IDENTITY"));
                        Execute(connection, transaction,
                            "INSERT INTO t_b_IDCard (f_CardNO,f_CardStatusDesc,f_ConsumerID) VALUES (?,?,?)",
                            task.wgCardNo, "0", consumerId.Value);
                    }

                    var output = new List<object>();
                    foreach (var target in targets)
                    {
                        var doors = IcCardDoors(connection, transaction, target.buildingNo);
                        foreach (var door in doors)
                        {
                            var count = Convert.ToInt32(Scalar(connection, transaction,
                                "SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=? AND f_DoorID=?",
                                consumerId.Value, door));
                            if (count == 0)
                                Execute(connection, transaction,
                                    "INSERT INTO t_d_Privilege (f_DoorID,f_ControlSegID,f_ConsumerID) VALUES (?,?,?)",
                                    door, 1, consumerId.Value);
                        }
                        var savedGroupId = ScalarInt(connection, transaction,
                            "SELECT f_GroupID FROM t_b_Consumer WHERE f_ConsumerID=?", consumerId.Value);
                        var savedGroupName = ScalarString(connection, transaction,
                            "SELECT f_GroupName FROM t_b_Group WHERE f_GroupID=?", savedGroupId);
                        if (!savedGroupId.HasValue || savedGroupId.Value != group.Id ||
                            !String.Equals(savedGroupName, group.Name, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException(homeBuildingNo + "号楼用户组写入后读回不一致，事务已取消");
                        var verifiedDoors = doors.Select(door => ReadIcCardDoorLabel(
                            connection, transaction, door, target.buildingNo)).ToArray();
                        output.Add(new AccessDatabaseWriteResult
                        {
                            buildingId = target.id,
                            buildingNo = target.buildingNo,
                            accessSystem = "iccard",
                            status = "access_db_written",
                            databaseRecord = "ConsumerID=" + consumerId.Value + ";GroupID=" + group.Id,
                            groupId = group.Id,
                            groupName = group.Name,
                            doors = verifiedDoors
                        });
                    }
                    transaction.Commit();
                    return output;
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        internal static string ExtractRoomBuildingNo(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return null;
            var match = Regex.Match(value.Trim(), @"^(?:已隐藏)?\s*\d+\s*/\s*(\d{1,3})\s*/");
            return match.Success ? NormalizeBuilding(match.Groups[1].Value) : null;
        }

        internal static IcCardGroupCandidate SelectIcCardGroup(string buildingNo, IEnumerable<IcCardGroupCandidate> groups)
        {
            var normalized = NormalizeBuilding(buildingNo);
            var matches = (groups ?? Enumerable.Empty<IcCardGroupCandidate>())
                .Where(item => item != null && NormalizeBuilding(ExtractBuildingNo(item.Name)) == normalized)
                .GroupBy(item => item.Id)
                .Select(group => group.First())
                .ToArray();
            if (matches.Length == 0)
                throw new InvalidOperationException(buildingNo + "号楼在 iCCard 用户组中没有精确匹配，请先核对 t_b_Group");
            if (matches.Length > 1)
                throw new InvalidOperationException(buildingNo + "号楼在 iCCard 用户组中匹配到多条记录，已停止写入");
            return matches[0];
        }

        private static IcCardGroupCandidate ResolveIcCardGroup(
            OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            var groups = new List<IcCardGroupCandidate>();
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT f_GroupID,f_GroupName FROM t_b_Group";
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) groups.Add(new IcCardGroupCandidate
                    {
                        Id = Convert.ToInt32(reader["f_GroupID"]),
                        Name = Text(reader, "f_GroupName")
                    });
            }
            return SelectIcCardGroup(buildingNo, groups);
        }

        private static string ReadIcCardDoorLabel(
            OleDbConnection connection, OleDbTransaction transaction, int doorId, string buildingNo)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT D.f_DoorName,C.f_ControllerName " +
                    "FROM t_b_Door AS D LEFT JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID " +
                    "WHERE D.f_DoorID=?";
                command.Parameters.AddWithValue("@door", doorId);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read()) throw new InvalidOperationException("iCCard 门 " + doorId + " 写入后无法读回");
                    var doorName = Text(reader, "f_DoorName");
                    var controllerName = Text(reader, "f_ControllerName");
                    if (NormalizeBuilding(ExtractBuildingNo(doorName, controllerName)) != NormalizeBuilding(buildingNo))
                        throw new InvalidOperationException(buildingNo + "号楼门权限读回到其他楼栋，事务已取消");
                    return doorId + ":" + doorName + (String.IsNullOrWhiteSpace(controllerName) ? "" : " / " + controllerName);
                }
            }
        }

        // 已知现场验证过的门保留为兜底；其它楼栋从现场数据库按门名/控制器名唯一解析。
        private static string[] MjDoors(OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            if (NormalizeBuilding(buildingNo) == "3") return new[] { "M0041-1" };
            if (NormalizeBuilding(buildingNo) == "26") return new[] { "M0038-1", "M0003-1", "M0030-1" };
            var doors = ResolveMjDoors(connection, transaction, buildingNo);
            if (doors.Length == 0) throw new InvalidOperationException(buildingNo + "号楼在 MjSystem 未找到可唯一识别的实体门，请先核对门名称");
            return doors;
        }

        private static int[] IcCardDoors(OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            if (NormalizeBuilding(buildingNo) == "11") return new[] { 26 };
            var doors = ResolveIcCardDoors(connection, transaction, buildingNo);
            if (doors.Length == 0) throw new InvalidOperationException(buildingNo + "号楼在 iCCard 未找到可唯一识别的实体门，请先核对门名称");
            return doors;
        }

        private static string[] ResolveMjDoors(OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            var normalized = NormalizeBuilding(buildingNo);
            var matches = new List<string>();
            const string sql =
                "SELECT D.cDoorId,D.vDoorName,M.vExposition " +
                "FROM MJ_DoorInfo AS D LEFT JOIN MJ_MacInfo AS M ON D.cMacId=M.cMacId";
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = sql;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var doorId = Text(reader, "cDoorId");
                        var doorName = Text(reader, "vDoorName");
                        var controller = Text(reader, "vExposition");
                        if (NormalizeBuilding(ExtractBuildingNo(doorName, controller)) == normalized)
                            matches.Add(doorId);
                    }
                }
            }
            return matches.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static int[] ResolveIcCardDoors(OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            var normalized = NormalizeBuilding(buildingNo);
            var matches = new List<int>();
            const string sql =
                "SELECT D.f_DoorID,D.f_DoorName,C.f_ControllerName " +
                "FROM t_b_Door AS D LEFT JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID";
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = sql;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var doorName = Text(reader, "f_DoorName");
                        var controller = Text(reader, "f_ControllerName");
                        if (NormalizeBuilding(ExtractBuildingNo(doorName, controller)) == normalized)
                            matches.Add(Convert.ToInt32(reader["f_DoorID"]));
                    }
                }
            }
            return matches.Distinct().ToArray();
        }

        private static string NormalizeBuilding(string value)
        {
            var trimmed = (value ?? "").TrimStart('0');
            return trimmed.Length == 0 ? "0" : trimmed;
        }

        private static string Limit(string value, int length)
        {
            value = value ?? "";
            return value.Length <= length ? value : value.Substring(0, length);
        }

        private static OleDbConnection Open(string path, string password, string name)
        {
            if (String.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new FileNotFoundException(name + " 数据库不存在", path);
            var builder = new OleDbConnectionStringBuilder { Provider = "Microsoft.Jet.OLEDB.4.0", DataSource = path };
            if (!String.IsNullOrEmpty(password)) builder["Jet OLEDB:Database Password"] = password;
            var connection = new OleDbConnection(builder.ConnectionString);
            connection.Open();
            return connection;
        }

        private static object Scalar(OleDbConnection connection, OleDbTransaction transaction, string sql, params object[] values)
        {
            using (var command = Command(connection, transaction, sql, values)) return command.ExecuteScalar();
        }

        private static int? ScalarInt(OleDbConnection connection, OleDbTransaction transaction, string sql, params object[] values)
        {
            var value = Scalar(connection, transaction, sql, values);
            return value == null || value == DBNull.Value ? (int?)null : Convert.ToInt32(value);
        }

        private static string ScalarString(OleDbConnection connection, OleDbTransaction transaction, string sql, params object[] values)
        {
            var value = Scalar(connection, transaction, sql, values);
            return value == null || value == DBNull.Value ? null : Convert.ToString(value);
        }

        private static void Execute(OleDbConnection connection, OleDbTransaction transaction, string sql, params object[] values)
        {
            using (var command = Command(connection, transaction, sql, values)) command.ExecuteNonQuery();
        }

        private static OleDbCommand Command(OleDbConnection connection, OleDbTransaction transaction, string sql, object[] values)
        {
            var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            foreach (var value in values) command.Parameters.AddWithValue("@value", value ?? DBNull.Value);
            return command;
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
