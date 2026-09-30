using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.IO;
using System.Linq;

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
        public string[] doors { get; set; }
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

        private static IEnumerable<object> ActivateMjSystem(AgentConfig config, AgentTask task, AccessTargetBuilding[] targets)
        {
            var connection = Open(config.MjSystemDatabasePath, null, "MjSystem");
            using (connection)
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    var marker = "PMS_ITEM_" + task.itemId;
                    var employeeId = ScalarInt(connection, transaction,
                        "SELECT EId FROM Employee WHERE vCardNo=?", task.wgCardNo);
                    if (employeeId.HasValue)
                    {
                        var memo = ScalarString(connection, transaction,
                            "SELECT EmpMemo FROM Employee WHERE EId=?", employeeId.Value);
                        if (!String.Equals(memo, marker, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("WG 卡号已存在 MjSystem，但不属于当前 PMS 任务");
                    }
                    else
                    {
                        Execute(connection, transaction,
                            "INSERT INTO Employee (vEmp_id,vEmp_name,vCardNo,vDepart,vDoorPassword,dBeginDate,dEndDate,EmpMemo,bWorkAttend) VALUES (?,?,?,?,?,?,?,?,?)",
                            "P" + task.itemId, Limit(task.address, 50), task.wgCardNo, "PMS 门禁发卡", "000000",
                            DateTime.Today, new DateTime(2099, 12, 31), marker, true);
                        employeeId = Convert.ToInt32(Scalar(connection, transaction, "SELECT @@IDENTITY"));
                    }

                    var output = new List<object>();
                    foreach (var target in targets)
                    {
                        var doors = MjDoors(target.buildingNo);
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
                    var marker = "PMS_ITEM_" + task.itemId;
                    var consumerId = ScalarInt(connection, transaction,
                        "SELECT f_ConsumerID FROM t_b_IDCard WHERE f_CardNO=?", task.wgCardNo);
                    if (consumerId.HasValue)
                    {
                        var note = ScalarString(connection, transaction,
                            "SELECT f_Note FROM t_b_Consumer WHERE f_ConsumerID=?", consumerId.Value);
                        if (!String.Equals(note, marker, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("WG 卡号已存在 iCCard，但不属于当前 PMS 任务");
                    }
                    else
                    {
                        var nextNo = Convert.ToInt32(Scalar(connection, transaction,
                            "SELECT MAX(f_ConsumerNO) FROM t_b_Consumer")) + 1;
                        Execute(connection, transaction,
                            "INSERT INTO t_b_Consumer (f_ConsumerNO,f_ConsumerName,f_ConsumerGrade,f_GroupID,f_AttendEnabled,f_DoorEnabled,f_BeginYMD,f_EndYMD,f_Note,f_PatrolEnabled,f_bShift) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                            nextNo, Limit(task.address, 50), "0", 11, 1, 1, DateTime.Today,
                            new DateTime(2099, 12, 31), marker, 0, 0);
                        consumerId = Convert.ToInt32(Scalar(connection, transaction, "SELECT @@IDENTITY"));
                        Execute(connection, transaction,
                            "INSERT INTO t_b_IDCard (f_CardNO,f_CardStatusDesc,f_ConsumerID) VALUES (?,?,?)",
                            task.wgCardNo, "0", consumerId.Value);
                    }

                    var output = new List<object>();
                    foreach (var target in targets)
                    {
                        var doors = IcCardDoors(target.buildingNo);
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
                        output.Add(new AccessDatabaseWriteResult
                        {
                            buildingId = target.id,
                            buildingNo = target.buildingNo,
                            accessSystem = "iccard",
                            status = "access_db_written",
                            databaseRecord = "ConsumerID=" + consumerId.Value,
                            doors = doors.Select(value => value.ToString()).ToArray()
                        });
                    }
                    transaction.Commit();
                    return output;
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        // 目前只开放已在真实库写入并读回验证的两条路由。
        private static string[] MjDoors(string buildingNo)
        {
            if (NormalizeBuilding(buildingNo) == "26") return new[] { "M0038-1", "M0003-1", "M0030-1" };
            throw new InvalidOperationException(buildingNo + " 号楼 MjSystem 实体门映射尚未验收");
        }

        private static int[] IcCardDoors(string buildingNo)
        {
            if (NormalizeBuilding(buildingNo) == "11") return new[] { 26 };
            throw new InvalidOperationException(buildingNo + " 号楼 iCCard 实体门映射尚未验收");
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
