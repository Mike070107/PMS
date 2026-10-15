using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Globalization;
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

        /** 控制器确认撤销后，逐栋删除对应门禁数据库权限并回读；一栋失败不回滚其它楼栋。 */
        public static object[] RemovePermissions(AgentConfig config, string password, AgentTask task, object[] controllerResults)
        {
            return FinalizePermissionRemovals(task, controllerResults, delegate(AccessTargetBuilding target)
            {
                if (String.Equals(target.accessSystem, "mjsystem", StringComparison.OrdinalIgnoreCase))
                    RemoveMjPermission(config, task.wgCardNo, target);
                else if (String.Equals(target.accessSystem, "iccard", StringComparison.OrdinalIgnoreCase))
                    RemoveIcPermission(config, password, task.wgCardNo, target);
                else
                    throw new InvalidOperationException(target.buildingNo + "号楼未配置可识别的门禁系统");
            });
        }

        internal static object[] FinalizePermissionRemovals(
            AgentTask task,
            object[] controllerResults,
            Action<AccessTargetBuilding> removeDatabasePermission)
        {
            var rows = (controllerResults ?? new object[0]).OfType<AccessControllerUploadResult>().ToArray();
            foreach (var row in rows.Where(item =>
                String.Equals(item.status, "controller_removed", StringComparison.OrdinalIgnoreCase)))
            {
                var target = (task.targetBuildings ?? new AccessTargetBuilding[0]).SingleOrDefault(item =>
                    item.id == row.buildingId &&
                    String.Equals(NormalizeBuilding(item.buildingNo), NormalizeBuilding(row.buildingNo), StringComparison.OrdinalIgnoreCase));
                if (target == null)
                {
                    row.status = "controller_failed";
                    row.error = "控制器已确认撤销，但网关无法对应本次楼栋任务，门禁数据库未修改";
                    continue;
                }
                try
                {
                    removeDatabasePermission(target);
                    row.acknowledgement = (String.IsNullOrWhiteSpace(row.acknowledgement)
                        ? "控制器已确认删除" : row.acknowledgement) + "；门禁数据库已回读确认删除";
                }
                catch (Exception exception)
                {
                    row.status = "controller_failed";
                    row.error = "控制器已确认撤销，但门禁数据库删除或回读失败：" + exception.Message;
                }
            }
            return rows.Cast<object>().ToArray();
        }

        private static void RemoveMjPermission(AgentConfig config, string cardNo, AccessTargetBuilding target)
        {
            using (var connection = Open(config.MjSystemDatabasePath, null, "MjSystem"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    var door = MjDoors(connection, transaction, target.buildingNo).Single();
                    using (var command = Command(connection, transaction,
                        "DELETE FROM MJ_MacPower WHERE cCardNo=? AND cDoorId=?", new object[] { cardNo, door })) command.ExecuteNonQuery();
                    if (Convert.ToInt32(Scalar(connection, transaction,
                        "SELECT COUNT(*) FROM MJ_MacPower WHERE cCardNo=? AND cDoorId=?", cardNo, door)) != 0)
                        throw new InvalidOperationException(target.buildingNo + "号楼 MjSystem 权限删除后读回仍存在");
                    transaction.Commit();
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static void RemoveIcPermission(AgentConfig config, string password, string cardNo, AccessTargetBuilding target)
        {
            using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    var consumer = Scalar(connection, transaction,
                        "SELECT TOP 1 f_ConsumerID FROM t_b_IDCard WHERE f_CardNO=?", cardNo);
                    if (consumer != null && consumer != DBNull.Value)
                    {
                        var door = IcCardDoors(connection, transaction, target.buildingNo).Single();
                        using (var command = Command(connection, transaction,
                            "DELETE FROM t_d_Privilege WHERE f_ConsumerID=? AND f_DoorID=?", new object[] { consumer, door })) command.ExecuteNonQuery();
                        if (Convert.ToInt32(Scalar(connection, transaction,
                            "SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=? AND f_DoorID=?", consumer, door)) != 0)
                            throw new InvalidOperationException(target.buildingNo + "号楼 iCCard 权限删除后读回仍存在");
                    }
                    transaction.Commit();
                }
                catch { transaction.Rollback(); throw; }
            }
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

        internal static string BuildMjSystemDepartment(string displayName)
        {
            var parts = (displayName ?? "").Split('/');
            int buildingNo;
            if (parts.Length < 2 || String.IsNullOrWhiteSpace(parts[0]) ||
                !Int32.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out buildingNo) ||
                buildingNo < 0 || buildingNo > 999)
                throw new InvalidOperationException("无法从用户姓名生成 MjSystem 部门，必须使用“弄号/楼栋/房号/序号”格式");
            return parts[0].Trim() + "弄" + buildingNo.ToString("D2", CultureInfo.InvariantCulture) + "号大门";
        }

        internal static string MjSystemEmployeeNumber(int employeeId)
        {
            if (employeeId <= 0) throw new InvalidOperationException("MjSystem 员工序号无效");
            return employeeId.ToString(CultureInfo.InvariantCulture);
        }

        internal static string ExtractBuildingNo(params string[] values)
        {
            foreach (var value in values)
            {
                if (String.IsNullOrWhiteSpace(value)) continue;
                var exactNumber = Regex.Match(value, @"^\s*(\d{1,3})\s*$");
                if (exactNumber.Success)
                {
                    var exactNormalized = exactNumber.Groups[1].Value.TrimStart('0');
                    return exactNormalized.Length == 0 ? "0" : exactNormalized;
                }
                var singleDoorController = Regex.Match(value,
                    @"(?<!\d)(\d{1,3})\s*号\s*单门控制器", RegexOptions.IgnoreCase);
                if (singleDoorController.Success)
                {
                    var controllerNormalized = singleDoorController.Groups[1].Value.TrimStart('0');
                    return controllerNormalized.Length == 0 ? "0" : controllerNormalized;
                }
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
                    var displayName = UserDisplayName(task);
                    var department = BuildMjSystemDepartment(displayName);
                    var employeeId = ScalarInt(connection, transaction,
                        "SELECT EId FROM Employee WHERE vCardNo=?", task.wgCardNo);
                    if (employeeId.HasValue)
                    {
                        var memo = ScalarString(connection, transaction,
                            "SELECT EmpMemo FROM Employee WHERE EId=?", employeeId.Value);
                        if (!isExistingCardGrant && !String.Equals(memo, marker, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("WG 卡号已存在 MjSystem，但不属于当前 PMS 任务");
                        if (!String.IsNullOrWhiteSpace(memo) && memo.StartsWith("PMS_", StringComparison.OrdinalIgnoreCase))
                            Execute(connection, transaction,
                                "UPDATE Employee SET vEmp_id=?,vEmp_name=?,vDepart=? WHERE EId=?",
                                MjSystemEmployeeNumber(employeeId.Value), Limit(displayName, 50), department, employeeId.Value);
                        else
                            Execute(connection, transaction,
                                "UPDATE Employee SET vEmp_name=?,vDepart=? WHERE EId=?",
                                Limit(displayName, 50), department, employeeId.Value);
                    }
                    else
                    {
                        var expectedEmployeeId = (ScalarInt(connection, transaction, "SELECT MAX(EId) FROM Employee") ?? 0) + 1;
                        Execute(connection, transaction,
                            "INSERT INTO Employee (vEmp_id,vEmp_name,vCardNo,vDepart,vDoorPassword,dBeginDate,dEndDate,EmpMemo,bWorkAttend) VALUES (?,?,?,?,?,?,?,?,?)",
                            MjSystemEmployeeNumber(expectedEmployeeId),
                            Limit(displayName, 50), task.wgCardNo, department, "000000",
                            DateTime.Today, new DateTime(2099, 12, 31), marker, true);
                        employeeId = Convert.ToInt32(Scalar(connection, transaction, "SELECT @@IDENTITY"));
                        Execute(connection, transaction,
                            "UPDATE Employee SET vEmp_id=? WHERE EId=?",
                            MjSystemEmployeeNumber(employeeId.Value), employeeId.Value);
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

        // 所有楼栋都从现场数据库按门名/控制器名唯一解析。
        // 不允许在代码中把一个楼栋扩展成多个门；跨楼栋权限只能来自 PMS 页面明确选中的 targetBuildings。
        private static string[] MjDoors(OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            return RequireSingleMjDoors(buildingNo, ResolveMjDoors(connection, transaction, buildingNo));
        }

        private static int[] IcCardDoors(OleDbConnection connection, OleDbTransaction transaction, string buildingNo)
        {
            return RequireSingleIcCardDoors(buildingNo, ResolveIcCardDoors(connection, transaction, buildingNo));
        }

        internal static string[] RequireSingleMjDoors(string buildingNo, string[] doors)
        {
            var unique = (doors ?? new string[0]).Where(item => !String.IsNullOrWhiteSpace(item))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (unique.Length != 1)
                throw new InvalidOperationException(buildingNo + "号楼在 MjSystem 未找到可唯一识别的实体门，请先核对门名称");
            return unique;
        }

        internal static int[] RequireSingleIcCardDoors(string buildingNo, int[] doors)
        {
            var unique = (doors ?? new int[0]).Distinct().ToArray();
            if (unique.Length != 1)
                throw new InvalidOperationException(buildingNo + "号楼在 iCCard 未找到可唯一识别的实体门，请先核对门名称");
            return unique;
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
