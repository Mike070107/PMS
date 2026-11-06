using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Globalization;
using System.IO;
using System.Linq;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessLifecycleRequest
    {
        /** extend / lost / unlost / cancel */
        public string operation { get; set; }
        public string wgCardNo { get; set; }
        public DateTime? endDate { get; set; }
        public string reason { get; set; }
        public string requestKey { get; set; }
        /** 允许操作没有 PMS_ 标记的历史卡；默认 false，必须由操作人显式打开。 */
        public bool allowNonPms { get; set; }
        /** 解挂时恢复的门 ID；.88 iCCard 用 f_DoorID，MjSystem 不支持解挂。 */
        public int[] restoreDoorIds { get; set; }
    }

    internal sealed class AccessLifecycleRow
    {
        public string accessSystem { get; set; }
        /** completed / skipped / failed */
        public string status { get; set; }
        public string detail { get; set; }
        public string beforeValue { get; set; }
        public string afterValue { get; set; }
        public string error { get; set; }
    }

    internal sealed class AccessLifecycleResult
    {
        public string operation { get; set; }
        public string wgCardNo { get; set; }
        public List<AccessLifecycleRow> rows { get; set; }
        public AccessLifecycleResult()
        {
            rows = new List<AccessLifecycleRow>();
        }
    }

    /**
     * .88 Access MDB 的卡片生命周期写入。
     *
     * 安全边界：
     * - 默认关闭，必须在 agent.config.json 设 "AccessLifecycleEnabled": true 才执行；
     * - iCCard 挂失/注销状态码必须由现场配置（AccessLostStatus / AccessCancelStatus），
     *   未配置直接拒绝，不在代码里猜 0/1/2 的含义；
     * - MjSystem 没有挂失字段，挂失/解挂明确拒绝，需现场取证；
     * - 所有写操作单事务、参数化、写后回读；同一请求重试按日期/状态判断幂等；
     * - 默认只允许带 PMS_ 标记的卡，历史卡必须显式 allowNonPms。
     */
    internal static class AccessCardLifecycle
    {
        public const string OperationExtend = "extend";
        public const string OperationLost = "lost";
        public const string OperationUnlost = "unlost";
        public const string OperationCancel = "cancel";

        public static AccessLifecycleResult Execute(AgentConfig config, string password, AccessLifecycleRequest request)
        {
            if (config == null) throw new ArgumentNullException("config");
            if (request == null) throw new ArgumentNullException("request");
            if (!config.AccessLifecycleEnabled)
                throw new InvalidOperationException("门禁卡生命周期写入未启用：请在 .88 的 agent.config.json 设置 AccessLifecycleEnabled=true，并先完成副本验证");
            if (String.IsNullOrWhiteSpace(request.wgCardNo))
                throw new InvalidOperationException("WG 卡号不能为空");
            request.wgCardNo = request.wgCardNo.Trim();
            if (!request.wgCardNo.All(Char.IsDigit) || request.wgCardNo.Length != 8)
                throw new InvalidOperationException("WG 卡号必须是 8 位数字");
            if (String.IsNullOrWhiteSpace(request.requestKey))
                request.requestKey = DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);

            var result = new AccessLifecycleResult
            {
                operation = request.operation,
                wgCardNo = request.wgCardNo
            };
            if (String.Equals(request.operation, OperationExtend, StringComparison.OrdinalIgnoreCase))
            {
                if (!request.endDate.HasValue)
                    throw new InvalidOperationException("延期必须提供目标到期日");
                RunSystem(result, "mjsystem", delegate { ExtendMjSystem(config, request, result); });
                RunSystem(result, "iccard", delegate { ExtendIcCard(config, password, request, result); });
                return result;
            }
            if (String.Equals(request.operation, OperationCancel, StringComparison.OrdinalIgnoreCase))
            {
                RunSystem(result, "mjsystem", delegate { CancelMjSystem(config, request, result); });
                RunSystem(result, "iccard", delegate { CancelIcCard(config, password, request, result); });
                return result;
            }
            if (String.Equals(request.operation, OperationLost, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(request.operation, OperationUnlost, StringComparison.OrdinalIgnoreCase))
            {
                var lost = String.Equals(request.operation, OperationLost, StringComparison.OrdinalIgnoreCase);
                result.rows.Add(new AccessLifecycleRow
                {
                    accessSystem = "mjsystem",
                    status = "failed",
                    error = "MjSystem 没有挂失/解挂字段，PMS 不能猜测原软件行为；请先现场取证或只操作 iCCard。"
                });
                if (lost) ReportIcLost(config, password, request, result);
                else UnreportIcLost(config, password, request, result);
                return result;
            }
            throw new InvalidOperationException("不支持的生命周期操作：" + request.operation);
        }

        private static void RunSystem(AccessLifecycleResult result, string accessSystem, Action action)
        {
            try
            {
                action();
            }
            catch (Exception exception)
            {
                result.rows.Add(new AccessLifecycleRow
                {
                    accessSystem = accessSystem,
                    status = "failed",
                    error = exception.Message
                });
            }
        }

        // ---------------- MjSystem ----------------

        private static void ExtendMjSystem(AgentConfig config, AccessLifecycleRequest request, AccessLifecycleResult result)
        {
            var target = request.endDate.Value.Date;
            using (var connection = Open(config.MjSystemDatabasePath, null, "MjSystem"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    int employeeId;
                    DateTime? end;
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT EId,vEmp_name,dBeginDate,dEndDate,EmpMemo FROM Employee WHERE vCardNo=?";                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        using (var reader = command.ExecuteReader())
                        {
                            if (!reader.Read())
                                throw new InvalidOperationException("MjSystem 未找到 WG 卡号 " + request.wgCardNo + " 的员工记录");
                            employeeId = Convert.ToInt32(reader["EId"]);
                            end = reader["dEndDate"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["dEndDate"], CultureInfo.InvariantCulture);
                            reader.Close();
                        }
                    }
                    var before = end.HasValue ? end.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : "未设置";
                    if (end.HasValue && end.Value.Date == target)
                    {
                        transaction.Rollback();
                        result.rows.Add(new AccessLifecycleRow
                        {
                            accessSystem = "mjsystem", status = "skipped",
                            detail = "到期日已经是目标日期", beforeValue = before,
                            afterValue = before
                        });
                        return;
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "UPDATE Employee SET dEndDate=? WHERE EId=?";
                        command.Parameters.AddWithValue("@end", target);
                        command.Parameters.AddWithValue("@id", employeeId);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("MjSystem 延期更新行数不为 1");
                    }
                    using (var verify = connection.CreateCommand())
                    {
                        verify.Transaction = transaction;
                        verify.CommandText = "SELECT dEndDate FROM Employee WHERE EId=?";
                        verify.Parameters.AddWithValue("@id", employeeId);
                        var saved = verify.ExecuteScalar();
                        if (saved == null || saved == DBNull.Value ||
                            Convert.ToDateTime(saved, CultureInfo.InvariantCulture).Date != target)
                            throw new InvalidOperationException("MjSystem 延期写后回读不一致");
                    }
                    transaction.Commit();
                    result.rows.Add(new AccessLifecycleRow
                    {
                        accessSystem = "mjsystem", status = "completed",
                        detail = "Employee EId=" + employeeId + " 已延期，需重新下发控制器后才在设备生效",
                        beforeValue = before,
                        afterValue = target.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    });
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static void CancelMjSystem(AgentConfig config, AccessLifecycleRequest request, AccessLifecycleResult result)
        {
            using (var connection = Open(config.MjSystemDatabasePath, null, "MjSystem"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    int? employeeId = null;
                    string memo = null;
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT EId,EmpMemo FROM Employee WHERE vCardNo=?";
                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        using (var reader = command.ExecuteReader())
                        {
                            if (reader.Read())
                            {
                                employeeId = Convert.ToInt32(reader["EId"]);
                                memo = ReadText(reader, "EmpMemo");
                            }
                            reader.Close();
                        }
                    }
                    if (!employeeId.HasValue)
                    {
                        transaction.Rollback();
                        result.rows.Add(new AccessLifecycleRow
                        {
                            accessSystem = "mjsystem", status = "skipped", detail = "MjSystem 没有该卡号记录，视为已注销"
                        });
                        return;
                    }
                    if (!request.allowNonPms && !IsPmsRecord(memo))
                        throw new InvalidOperationException("该卡不是 PMS 发出的记录（EmpMemo 无 PMS_ 标记），如确认要注销历史卡请显式允许非 PMS 记录");
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "DELETE FROM MJ_MacPower WHERE cCardNo=?";
                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        command.ExecuteNonQuery();
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "DELETE FROM Employee WHERE EId=?";
                        command.Parameters.AddWithValue("@id", employeeId.Value);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("MjSystem 删除员工记录行数不为 1");
                    }
                    var remainingEmployees = Convert.ToInt32(Scalar(connection, transaction,
                        "SELECT COUNT(*) FROM Employee WHERE vCardNo=?", request.wgCardNo));
                    var remainingPermissions = Convert.ToInt32(Scalar(connection, transaction,
                        "SELECT COUNT(*) FROM MJ_MacPower WHERE cCardNo=?", request.wgCardNo));
                    if (remainingEmployees != 0 || remainingPermissions != 0)
                        throw new InvalidOperationException("MjSystem 注销后读回仍存在员工或权限记录");
                    transaction.Commit();
                    result.rows.Add(new AccessLifecycleRow
                    {
                        accessSystem = "mjsystem", status = "completed",
                        detail = "Employee EId=" + employeeId.Value + " 与门权限已删除并读回确认；原软件界面需刷新"
                    });
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        // ---------------- iCCard ----------------

        private static void ExtendIcCard(AgentConfig config, string password, AccessLifecycleRequest request, AccessLifecycleResult result)
        {
            var target = request.endDate.Value.Date;
            using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    int consumerId;
                    int cardId;
                    DateTime? end;
                    DateTime? deadline;
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT I.f_CardID,I.f_ConsumerID,C.f_EndYMD,I.f_Deadline " +
                            "FROM (t_b_IDCard AS I INNER JOIN t_b_Consumer AS C ON I.f_ConsumerID=C.f_ConsumerID) " +
                            "WHERE I.f_CardNO=?";
                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        using (var reader = command.ExecuteReader())
                        {
                            if (!reader.Read())
                                throw new InvalidOperationException("iCCard 未找到 WG 卡号 " + request.wgCardNo + " 的卡片记录");
                            cardId = Convert.ToInt32(reader["f_CardID"]);
                            consumerId = Convert.ToInt32(reader["f_ConsumerID"]);
                            end = reader["f_EndYMD"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["f_EndYMD"], CultureInfo.InvariantCulture);
                            deadline = reader["f_Deadline"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["f_Deadline"], CultureInfo.InvariantCulture);
                            reader.Close();
                        }
                    }
                    var before = end.HasValue ? end.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : "未设置";
                    if (end.HasValue && end.Value.Date == target && (!deadline.HasValue || deadline.Value.Date == target))
                    {
                        transaction.Rollback();
                        result.rows.Add(new AccessLifecycleRow
                        {
                            accessSystem = "iccard", status = "skipped",
                            detail = "有效期已经是目标日期", beforeValue = before,
                            afterValue = before
                        });
                        return;
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "UPDATE t_b_Consumer SET f_EndYMD=? WHERE f_ConsumerID=?";
                        command.Parameters.AddWithValue("@end", target);
                        command.Parameters.AddWithValue("@id", consumerId);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("iCCard 用户有效期更新行数不为 1");
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "UPDATE t_b_IDCard SET f_Deadline=? WHERE f_CardID=?";
                        command.Parameters.AddWithValue("@deadline", target);
                        command.Parameters.AddWithValue("@id", cardId);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("iCCard 卡片有效期更新行数不为 1");
                    }
                    using (var verify = connection.CreateCommand())
                    {
                        verify.Transaction = transaction;
                        verify.CommandText = "SELECT C.f_EndYMD,I.f_Deadline FROM (t_b_IDCard AS I INNER JOIN t_b_Consumer AS C " +
                            "ON I.f_ConsumerID=C.f_ConsumerID) WHERE I.f_CardID=?";
                        verify.Parameters.AddWithValue("@id", cardId);
                        using (var reader = verify.ExecuteReader())
                        {
                            if (!reader.Read()) throw new InvalidOperationException("iCCard 延期写后无法回读");
                            var savedEnd = reader["f_EndYMD"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["f_EndYMD"], CultureInfo.InvariantCulture);
                            var savedDeadline = reader["f_Deadline"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["f_Deadline"], CultureInfo.InvariantCulture);
                            if (!savedEnd.HasValue || savedEnd.Value.Date != target ||
                                !savedDeadline.HasValue || savedDeadline.Value.Date != target)
                                throw new InvalidOperationException("iCCard 延期写后回读不一致");
                        }
                    }
                    transaction.Commit();
                    result.rows.Add(new AccessLifecycleRow
                    {
                        accessSystem = "iccard", status = "completed",
                        detail = "ConsumerID=" + consumerId + " / CardID=" + cardId + " 已延期，需重新下发控制器后才在设备生效",
                        beforeValue = before,
                        afterValue = target.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    });
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static void ReportIcLost(AgentConfig config, string password, AccessLifecycleRequest request, AccessLifecycleResult result)
        {
            var lostStatus = config.AccessLostStatus;
            if (String.IsNullOrWhiteSpace(lostStatus))
                throw new InvalidOperationException("iCCard 挂失状态码未配置：请在 .88 的 agent.config.json 设置 AccessLostStatus（现场取证后填写）");
            using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    int cardId;
                    int consumerId;
                    string status;
                    DateTime? lostDate;
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT f_CardID,f_ConsumerID,f_CardStatusDesc,f_LostDate FROM t_b_IDCard WHERE f_CardNO=?";
                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        using (var reader = command.ExecuteReader())
                        {
                            if (!reader.Read())
                                throw new InvalidOperationException("iCCard 未找到 WG 卡号 " + request.wgCardNo + " 的卡片记录");
                            cardId = Convert.ToInt32(reader["f_CardID"]);
                            consumerId = Convert.ToInt32(reader["f_ConsumerID"]);
                            status = ReadText(reader, "f_CardStatusDesc");
                            lostDate = reader["f_LostDate"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["f_LostDate"], CultureInfo.InvariantCulture);
                            reader.Close();
                        }
                    }
                    if (lostDate.HasValue && status == lostStatus)
                    {
                        transaction.Rollback();
                        result.rows.Add(new AccessLifecycleRow
                        {
                            accessSystem = "iccard", status = "skipped", detail = "该卡已经是挂失状态"
                        });
                        return;
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "UPDATE t_b_IDCard SET f_CardStatusDesc=?,f_LostDate=?,f_StatusChangeDate=? WHERE f_CardID=?";
                        command.Parameters.AddWithValue("@status", lostStatus);
                        command.Parameters.AddWithValue("@lost", DateTime.Now);
                        command.Parameters.AddWithValue("@changed", DateTime.Now);
                        command.Parameters.AddWithValue("@id", cardId);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("iCCard 挂失更新行数不为 1");
                    }
                    var removedDoors = DeleteIcPrivileges(connection, transaction, consumerId);
                    VerifyIcStatus(connection, transaction, cardId, lostStatus, true);
                    transaction.Commit();
                    result.rows.Add(new AccessLifecycleRow
                    {
                        accessSystem = "iccard", status = "completed",
                        detail = "CardID=" + cardId + " 已挂失并删除 " + removedDoors.Length +
                            " 个门权限；需重新下发控制器后才在设备生效。恢复需要门 ID：" +
                            String.Join(",", removedDoors.Select(item => item.ToString(CultureInfo.InvariantCulture)).ToArray())
                    });
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static void UnreportIcLost(AgentConfig config, string password, AccessLifecycleRequest request, AccessLifecycleResult result)
        {
            var normalStatus = String.IsNullOrWhiteSpace(config.AccessNormalStatus) ? "0" : config.AccessNormalStatus.Trim();
            var doors = (request.restoreDoorIds ?? new int[0]).Distinct().ToArray();
            if (doors.Length == 0)
                throw new InvalidOperationException("iCCard 解挂需要提供恢复的门 ID（restoreDoorIds），否则卡会恢复成无权限状态");
            using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    int cardId;
                    int consumerId;
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT f_CardID,f_ConsumerID FROM t_b_IDCard WHERE f_CardNO=?";
                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        using (var reader = command.ExecuteReader())
                        {
                            if (!reader.Read())
                                throw new InvalidOperationException("iCCard 未找到 WG 卡号 " + request.wgCardNo + " 的卡片记录");
                            cardId = Convert.ToInt32(reader["f_CardID"]);
                            consumerId = Convert.ToInt32(reader["f_ConsumerID"]);
                            reader.Close();
                        }
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "UPDATE t_b_IDCard SET f_CardStatusDesc=?,f_LostDate=NULL,f_StatusChangeDate=? WHERE f_CardID=?";
                        command.Parameters.AddWithValue("@status", normalStatus);
                        command.Parameters.AddWithValue("@changed", DateTime.Now);
                        command.Parameters.AddWithValue("@id", cardId);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("iCCard 解挂更新行数不为 1");
                    }
                    foreach (var door in doors)
                    {
                        var exists = Convert.ToInt32(Scalar(connection, transaction,
                            "SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=? AND f_DoorID=?", consumerId, door));
                        if (exists == 0)
                            Execute(connection, transaction,
                                "INSERT INTO t_d_Privilege (f_DoorID,f_ControlSegID,f_ConsumerID) VALUES (?,?,?)",
                                door, 1, consumerId);
                    }
                    VerifyIcStatus(connection, transaction, cardId, normalStatus, false);
                    foreach (var door in doors)
                    {
                        var count = Convert.ToInt32(Scalar(connection, transaction,
                            "SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=? AND f_DoorID=?", consumerId, door));
                        if (count != 1) throw new InvalidOperationException("iCCard 解挂后门权限读回不一致：门 " + door);
                    }
                    transaction.Commit();
                    result.rows.Add(new AccessLifecycleRow
                    {
                        accessSystem = "iccard", status = "completed",
                        detail = "CardID=" + cardId + " 已解挂并恢复 " + doors.Length + " 个门权限；需重新下发控制器后才在设备生效"
                    });
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static void CancelIcCard(AgentConfig config, string password, AccessLifecycleRequest request, AccessLifecycleResult result)
        {
            var cancelStatus = config.AccessCancelStatus;
            if (String.IsNullOrWhiteSpace(cancelStatus))
                throw new InvalidOperationException("iCCard 注销状态码未配置：请在 .88 的 agent.config.json 设置 AccessCancelStatus（现场取证后填写）");
            using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    int cardId;
                    int consumerId;
                    DateTime? deletedDate;
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "SELECT f_CardID,f_ConsumerID,f_DeletedDate FROM t_b_IDCard WHERE f_CardNO=?";
                        command.Parameters.AddWithValue("@card", request.wgCardNo);
                        using (var reader = command.ExecuteReader())
                        {
                            if (!reader.Read())
                            {
                                reader.Close();
                                transaction.Rollback();
                                result.rows.Add(new AccessLifecycleRow
                                {
                                    accessSystem = "iccard", status = "skipped", detail = "iCCard 没有该卡号记录，视为已注销"
                                });
                                return;
                            }
                            cardId = Convert.ToInt32(reader["f_CardID"]);
                            consumerId = Convert.ToInt32(reader["f_ConsumerID"]);
                            deletedDate = reader["f_DeletedDate"] == DBNull.Value
                                ? (DateTime?)null
                                : Convert.ToDateTime(reader["f_DeletedDate"], CultureInfo.InvariantCulture);
                            reader.Close();
                        }
                    }
                    var privileged = Convert.ToInt32(Scalar(connection, transaction,
                        "SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=?", consumerId));
                    if (deletedDate.HasValue && privileged == 0)
                    {
                        transaction.Rollback();
                        result.rows.Add(new AccessLifecycleRow
                        {
                            accessSystem = "iccard", status = "skipped", detail = "该卡已经注销且无门权限"
                        });
                        return;
                    }
                    if (!request.allowNonPms)
                    {
                        var note = ScalarText(connection, transaction,
                            "SELECT f_Note FROM t_b_Consumer WHERE f_ConsumerID=?", consumerId);
                        if (!IsPmsRecord(note))
                            throw new InvalidOperationException("该卡不是 PMS 发出的记录（f_Note 无 PMS_ 标记），如确认要注销历史卡请显式允许非 PMS 记录");
                    }
                    using (var command = connection.CreateCommand())
                    {
                        command.Transaction = transaction;
                        command.CommandText = "UPDATE t_b_IDCard SET f_CardStatusDesc=?,f_DeletedDate=?,f_StatusChangeDate=? WHERE f_CardID=?";
                        command.Parameters.AddWithValue("@status", cancelStatus);
                        command.Parameters.AddWithValue("@deleted", DateTime.Now);
                        command.Parameters.AddWithValue("@changed", DateTime.Now);
                        command.Parameters.AddWithValue("@id", cardId);
                        if (command.ExecuteNonQuery() != 1) throw new InvalidOperationException("iCCard 注销更新行数不为 1");
                    }
                    var removedDoors = DeleteIcPrivileges(connection, transaction, consumerId);
                    VerifyIcStatus(connection, transaction, cardId, cancelStatus, false);
                    transaction.Commit();
                    result.rows.Add(new AccessLifecycleRow
                    {
                        accessSystem = "iccard", status = "completed",
                        detail = "CardID=" + cardId + " 已置注销并删除 " + removedDoors.Length +
                            " 个门权限，卡记录保留供审计；需重新下发控制器后才在设备生效"
                    });
                }
                catch { transaction.Rollback(); throw; }
            }
        }

        private static int[] DeleteIcPrivileges(OleDbConnection connection, OleDbTransaction transaction, int consumerId)
        {
            var doors = new List<int>();
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT f_DoorID FROM t_d_Privilege WHERE f_ConsumerID=?";
                command.Parameters.AddWithValue("@id", consumerId);
                using (var reader = command.ExecuteReader())
                    while (reader.Read()) doors.Add(Convert.ToInt32(reader["f_DoorID"]));
            }
            Execute(connection, transaction, "DELETE FROM t_d_Privilege WHERE f_ConsumerID=?", consumerId);
            return doors.Distinct().ToArray();
        }

        private static void VerifyIcStatus(OleDbConnection connection, OleDbTransaction transaction,
            int cardId, string expectedStatus, bool lostMustExist)
        {
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT f_CardStatusDesc,f_LostDate,f_DeletedDate FROM t_b_IDCard WHERE f_CardID=?";
                command.Parameters.AddWithValue("@id", cardId);
                using (var reader = command.ExecuteReader())
                {
                    if (!reader.Read()) throw new InvalidOperationException("iCCard 写后无法回读卡片");
                    var status = ReadText(reader, "f_CardStatusDesc");
                    var lostDate = reader["f_LostDate"] == DBNull.Value ? null : reader["f_LostDate"];
                    var deletedDate = reader["f_DeletedDate"] == DBNull.Value ? null : reader["f_DeletedDate"];
                    if (!String.Equals(status, expectedStatus, StringComparison.Ordinal))
                        throw new InvalidOperationException("iCCard 状态码写后回读不一致");
                    if (lostMustExist && lostDate == null)
                        throw new InvalidOperationException("iCCard 挂失日期写后回读为空");
                    if (!lostMustExist && expectedStatus == "0" && lostDate != null)
                        throw new InvalidOperationException("iCCard 解挂后挂失日期仍存在");
                    if (!lostMustExist && deletedDate == null && expectedStatus != "0")
                        throw new InvalidOperationException("iCCard 注销日期写后回读为空");
                }
            }
        }

        // ---------------- 通用 ----------------

        internal static bool IsPmsRecord(string value)
        {
            return !String.IsNullOrWhiteSpace(value) &&
                (value.Trim().StartsWith("PMS_", StringComparison.OrdinalIgnoreCase) ||
                 value.IndexOf("PMS_", StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static OleDbConnection Open(string path, string password, string name)
        {
            return AccessOleDb.Open(path, password, name);
        }

        private static object Scalar(OleDbConnection connection, OleDbTransaction transaction, string sql, params object[] values)
        {
            using (var command = Command(connection, transaction, sql, values)) return command.ExecuteScalar();
        }

        private static string ScalarText(OleDbConnection connection, OleDbTransaction transaction, string sql, params object[] values)
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

        private static string ReadText(OleDbDataReader reader, string field)
        {
            var value = reader[field];
            return value == null || value == DBNull.Value ? "" : Convert.ToString(value).Trim();
        }
    }
}
