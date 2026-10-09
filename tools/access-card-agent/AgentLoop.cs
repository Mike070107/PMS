using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Pms.AccessCardAgent
{
    internal sealed class AgentActivity
    {
        public DateTimeOffset OccurredAt { get; set; }
        public string Operation { get; set; }
        public string Target { get; set; }
        public bool Success { get; set; }
        public string Message { get; set; }
    }

    internal sealed class AgentLoop
    {
        private readonly AgentConfig _config;
        private readonly AgentApiClient _api;
        private readonly Func<string, string> _secretProvider;
        private readonly Action<bool, string> _connectionState;
        private readonly Action<AgentActivity> _activity;

        public AgentLoop(AgentConfig config, AgentApiClient api) : this(config, api, null, null, null)
        {
        }

        public AgentLoop(AgentConfig config, AgentApiClient api, Func<string, string> secretProvider, Action<bool, string> connectionState)
            : this(config, api, secretProvider, connectionState, null)
        {
        }

        public AgentLoop(AgentConfig config, AgentApiClient api, Func<string, string> secretProvider, Action<bool, string> connectionState, Action<AgentActivity> activity)
        {
            _config = config;
            _api = api;
            _secretProvider = secretProvider;
            _connectionState = connectionState;
            _activity = activity;
        }

        public void Run()
        {
            Run(null);
        }

        public void Run(WaitHandle stopSignal)
        {
            Console.WriteLine("PMS 数据同步助手已启动：" + _config.Name + " / " + _config.Kind);
            while (stopSignal == null || !stopSignal.WaitOne(0))
            {
                try
                {
                    var hasReader = _config.Kind != "issuer" || CardReader.HasAcr122();
                    var parkingWrite = false;
                    var accessWrite = false;
                    var controllerUpload = false;
                    if (_config.Kind == "parking_gateway")
                    {
                        parkingWrite = ParkingDatabase.CanWriteBoth(_config, LoadSecret("parking-db-password.dat"));
                    }
                    if (_config.Kind == "access_gateway")
                    {
                        AccessGatewayDatabase.ProbeMjSystem(_config);
                        AccessGatewayDatabase.ProbeIcCard(_config, LoadSecret("iccard-db-password.dat"));
                        accessWrite = true;
                        controllerUpload = AccessControllerUploader.CanUpload(_config);
                    }
                    _api.Heartbeat(BuildCapabilities(_config, hasReader, parkingWrite, accessWrite, controllerUpload));
                    AgentStatus.MarkConnected();
                    SetConnectionState(true, "PMS 心跳正常");
                    if (_config.Kind == "legacy_sync")
                    {
                        var cardCheckTask = _api.ClaimLegacyCardCheck();
                        if (cardCheckTask != null)
                        {
                            HandleLegacyCardCheck(cardCheckTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                        var historyTask = _api.ClaimLegacyHistory();
                        if (historyTask != null)
                        {
                            HandleLegacyHistory(historyTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                    }
                    if (_config.Kind == "parking_gateway")
                    {
                        var parkingOperationTask = _api.ClaimParkingOperation();
                        if (parkingOperationTask != null)
                        {
                            HandleParkingOperation(parkingOperationTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                        var ownerUpdateTask = _api.ClaimParkingOwnerUpdate();
                        if (ownerUpdateTask != null)
                        {
                            HandleParkingOwnerUpdate(ownerUpdateTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                        var parkingTask = _api.ClaimParkingQuery();
                        if (parkingTask != null)
                        {
                            HandleParkingQuery(parkingTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                    }
                    if (_config.Kind == "access_gateway")
                    {
                        var permissionTask = _api.ClaimAccessPermissions();
                        if (permissionTask != null)
                        {
                            HandleAccessPermissions(permissionTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                        var authorizationTask = _api.ClaimHistoryAuthorization();
                        if (authorizationTask != null)
                        {
                            HandleHistoryAuthorization(authorizationTask);
                            if (Wait(stopSignal, _config.PollIntervalMs)) return;
                            continue;
                        }
                    }
                    var task = _api.Claim();
                    if (task != null) Handle(task, hasReader);
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine(DateTime.Now.ToString("s") + " " + exception.Message);
                    SetConnectionState(false, exception.Message);
                }
                if (Wait(stopSignal, _config.PollIntervalMs)) return;
            }
        }

        private static bool Wait(WaitHandle stopSignal, int milliseconds)
        {
            if (stopSignal == null)
            {
                Thread.Sleep(milliseconds);
                return false;
            }
            return stopSignal.WaitOne(milliseconds);
        }

        internal static Dictionary<string, bool> BuildCapabilities(AgentConfig config, bool hasReader)
        {
            return BuildCapabilities(config, hasReader, false);
        }

        internal static Dictionary<string, bool> BuildCapabilities(AgentConfig config, bool hasReader, bool parkingWrite)
        {
            return BuildCapabilities(config, hasReader, parkingWrite, false);
        }

        internal static Dictionary<string, bool> BuildCapabilities(AgentConfig config, bool hasReader, bool parkingWrite, bool accessWrite)
        {
            return BuildCapabilities(config, hasReader, parkingWrite, accessWrite, false);
        }

        internal static Dictionary<string, bool> BuildCapabilities(AgentConfig config, bool hasReader, bool parkingWrite, bool accessWrite, bool controllerUpload)
        {
            return new Dictionary<string, bool>
            {
                { "pcscReader", hasReader },
                { "cardWrite", false },
                { "legacyDbRead", config.Kind == "legacy_sync" },
                { "legacyDbWrite", false },
                { "accessDbRead", config.Kind == "access_gateway" },
                { "accessDbWrite", config.Kind == "access_gateway" && accessWrite },
                { "parkingDbRead", config.Kind == "parking_gateway" },
                { "parkingDbWrite", config.Kind == "parking_gateway" && parkingWrite },
                { "controllerUpload", config.Kind == "access_gateway" && controllerUpload },
                { "historicalAccessGrant", config.Kind == "access_gateway" && accessWrite && controllerUpload }
            };
        }

        private void HandleLegacyHistory(LegacyHistoryTask task)
        {
            try
            {
                var result = LegacyDatabase.GetHistory(_config, LoadSecret("legacy-db-password.dat"), task.roomKey);
                _api.ReportLegacyHistory(new LegacyHistoryReport
                {
                    snapshotId = task.snapshotId,
                    result = "success",
                    issuedCount = result.issuedCount,
                    nextSequence = result.nextSequence,
                    history = result.history
                });
                RecordActivity("查询门禁卡", task.roomKey, true, "查到 " + result.history.Count + " 张历史卡");
            }
            catch (Exception exception)
            {
                _api.ReportLegacyHistory(new LegacyHistoryReport
                {
                    snapshotId = task.snapshotId,
                    result = "retry",
                    errorMessage = exception.Message
                });
                RecordActivity("查询门禁卡", task.roomKey, false, exception.Message);
            }
        }

        private void HandleParkingQuery(ParkingQueryTask task)
        {
            try
            {
                var rows = task.queryKind == "movement"
                    ? ParkingDatabase.SearchMovementsBoth(_config, LoadSecret("parking-db-password.dat"),
                        LoadOptionalSecret("parking-movement-db-password.dat"), task.term, task.startDate, task.endDate)
                    : ParkingDatabase.SearchBoth(_config, LoadSecret("parking-db-password.dat"), task.term);
                _api.ReportParkingQuery(new ParkingQueryReport
                {
                    queryId = task.queryId,
                    result = "success",
                    rows = rows
                });
                RecordActivity(task.queryKind == "movement" ? "查询车牌进出记录" : "查询停车记录", task.term, true, "查到 " + rows.Count + " 条记录");
            }
            catch (Exception exception)
            {
                _api.ReportParkingQuery(new ParkingQueryReport
                {
                    queryId = task.queryId,
                    result = "retry",
                    errorMessage = exception.Message
                });
                RecordActivity(task.queryKind == "movement" ? "查询车牌进出记录" : "查询停车记录", task.term, false, exception.Message);
            }
        }

        private void HandleParkingOwnerUpdate(ParkingOwnerUpdateTask task)
        {
            var target = task.database + " 住户 #" + task.externalOwnerId;
            ParkingOwnerValues values;
            try
            {
                values = ParkingDatabase.UpdateOwner(_config, LoadSecret("parking-db-password.dat"), task);
            }
            catch (ParkingOwnerConflictException exception)
            {
                _api.ReportParkingOwnerUpdate(new ParkingOwnerUpdateReport
                {
                    taskId = task.taskId,
                    result = "failed",
                    errorMessage = exception.Message
                });
                RecordActivity("更新停车住户资料", target, false, exception.Message);
                return;
            }
            catch (Exception exception)
            {
                _api.ReportParkingOwnerUpdate(new ParkingOwnerUpdateReport
                {
                    taskId = task.taskId,
                    result = IsTransientParkingFailure(exception) ? "retry" : "failed",
                    errorMessage = exception.Message
                });
                RecordActivity("更新停车住户资料", target, false, exception.Message);
                return;
            }
            // 写库已提交后，回报网络失败不等于写入失败。由租约重领和读回幂等确认，不能再发 failed。
            _api.ReportParkingOwnerUpdate(new ParkingOwnerUpdateReport { taskId = task.taskId, result = "success", values = values });
            RecordActivity("更新停车住户资料", target, true, "已写入旧系统并读回验证");
        }

        private void HandleParkingOperation(ParkingOperationTask task)
        {
            var target = task.database + " " + task.kind + " " + (Value(task.payload, "plate") ?? Value(task.payload, "newPlate") ?? "车牌");
            try
            {
                var result = ParkingDatabase.ExecuteOperation(_config, LoadSecret("parking-db-password.dat"), task);
                _api.ReportParkingOperation(new ParkingOperationReport { taskId = task.taskId, result = "success", values = result });
                RecordActivity("停车业务操作", target, true, "已调用旧系统存储过程并读回验证");
            }
            catch (Exception exception)
            {
                _api.ReportParkingOperation(new ParkingOperationReport
                {
                    taskId = task.taskId,
                    result = IsTransientParkingFailure(exception) ? "retry" : "failed",
                    errorMessage = exception.Message
                });
                RecordActivity("停车业务操作", target, false, exception.Message);
            }
        }

        private static string Value(Dictionary<string, object> values, string key)
        {
            if (values == null || !values.ContainsKey(key) || values[key] == null) return null;
            return Convert.ToString(values[key]);
        }

        private static bool IsTransientParkingFailure(Exception exception)
        {
            var sql = exception as System.Data.SqlClient.SqlException;
            if (sql == null) return exception is TimeoutException;
            foreach (System.Data.SqlClient.SqlError error in sql.Errors)
            {
                if (error.Number == -2 || error.Number == 1205 || error.Number == 233 || error.Number == 10053 ||
                    error.Number == 10054 || error.Number == 10060) return true;
            }
            return false;
        }

        private void HandleLegacyCardCheck(LegacyCardCheckTask task)
        {
            try
            {
                var matches = LegacyDatabase.FindCard(_config, LoadSecret("legacy-db-password.dat"), task.icCardNo);
                _api.ReportLegacyCardCheck(new LegacyCardCheckReport
                {
                    checkId = task.checkId,
                    result = "success",
                    matches = matches
                });
                RecordActivity("检查卡号", task.icCardNo, true, matches.Count == 0 ? "未发现重复卡" : "发现 " + matches.Count + " 条已有记录");
            }
            catch (Exception exception)
            {
                _api.ReportLegacyCardCheck(new LegacyCardCheckReport
                {
                    checkId = task.checkId,
                    result = "retry",
                    errorMessage = exception.Message
                });
                RecordActivity("检查卡号", task.icCardNo, false, exception.Message);
            }
        }

        private void HandleAccessPermissions(AccessPermissionTask task)
        {
            try
            {
                var permissions = AccessGatewayDatabase.FindPermissions(
                    _config,
                    LoadSecret("iccard-db-password.dat"),
                    task.cards);
                _api.ReportAccessPermissions(new AccessPermissionReport
                {
                    snapshotId = task.snapshotId,
                    result = "success",
                    permissions = permissions
                });
                RecordActivity("查询门禁权限", DescribeCards(task.cards), true, "已核对 " + permissions.Length + " 张卡的设备权限");
            }
            catch (Exception exception)
            {
                _api.ReportAccessPermissions(new AccessPermissionReport
                {
                    snapshotId = task.snapshotId,
                    result = "retry",
                    errorMessage = exception.Message
                });
                RecordActivity("查询门禁权限", DescribeCards(task.cards), false, exception.Message);
            }
        }

        private void HandleHistoryAuthorization(AgentTask task)
        {
            try
            {
                AccessGatewayDatabase.Activate(
                    _config,
                    LoadSecret("iccard-db-password.dat"),
                    task);
                var controllerResults = AccessControllerUploader.Upload(
                    _config,
                    LoadSecret("iccard-db-password.dat"),
                    task);
                _api.ReportHistoryAuthorization(new AccessCardAuthorizationReport
                {
                    taskId = task.taskId,
                    result = "success",
                    controllerResults = controllerResults
                });
                RecordActivity("追加门栋权限", task.wgCardNo, true, "数据库写入和控制器下发完成");
            }
            catch (Exception exception)
            {
                _api.ReportHistoryAuthorization(new AccessCardAuthorizationReport
                {
                    taskId = task.taskId,
                    result = "retry",
                    errorMessage = exception.Message
                });
                RecordActivity("追加门栋权限", task.wgCardNo, false, exception.Message);
            }
        }

        private static string DescribeCards(AccessPermissionTaskCard[] cards)
        {
            if (cards == null || cards.Length == 0) return "未提供卡号";
            var first = !String.IsNullOrWhiteSpace(cards[0].wgCardNo) ? cards[0].wgCardNo : cards[0].icCardNo;
            return cards.Length == 1 ? first : first + " 等 " + cards.Length + " 张卡";
        }

        private void Handle(AgentTask task, bool hasReader)
        {
            if (_config.Kind == "issuer" && !hasReader)
            {
                _api.Report(new AgentReport
                {
                    itemId = task.itemId,
                    result = "retry",
                    errorMessage = "未检测到 ACR122U，请检查 USB 和 PC/SC 驱动"
                });
                return;
            }
            if (_config.Kind == "issuer")
            {
                try
                {
                    var icCardNo = CardReader.ReadUid();
                    var preflight = _api.CardPreflight(task.itemId, icCardNo);
                    var status = preflight.ContainsKey("status") ? Convert.ToString(preflight["status"]) : "error";
                    var detail = preflight.ContainsKey("message") ? Convert.ToString(preflight["message"]) : "卡片查重未返回结果";
                    if (status == "duplicate") return; // API 已将任务标记为重复卡并释放租约。
                    if (status != "clear")
                    {
                        _api.Report(new AgentReport { itemId = task.itemId, result = "retry", errorMessage = detail });
                        return;
                    }
                }
                catch (Exception exception)
                {
                    _api.Report(new AgentReport { itemId = task.itemId, result = "retry", errorMessage = exception.Message });
                    return;
                }
            }
            if (_config.Kind == "access_gateway" && task.action == "activate_access")
            {
                try
                {
                    var results = AccessGatewayDatabase.Activate(
                        _config,
                        LoadSecret("iccard-db-password.dat"),
                        task);
                    var controllerResults = AccessControllerUploader.Upload(
                        _config,
                        LoadSecret("iccard-db-password.dat"),
                        task);
                    _api.Report(new AgentReport
                    {
                        itemId = task.itemId,
                        result = "success",
                        controllerResults = controllerResults
                    });
                    RecordActivity("下发门禁权限", task.wgCardNo, true, "数据库写入和控制器下发完成");
                }
                catch (Exception exception)
                {
                    _api.Report(new AgentReport
                    {
                        itemId = task.itemId,
                        result = "retry",
                        errorMessage = exception.Message
                    });
                    RecordActivity("下发门禁权限", task.wgCardNo, false, exception.Message);
                }
                return;
            }
            // 默认拒绝产生真实副作用；硬件和旧库适配器通过验收后逐项替换此分支。
            _api.Report(new AgentReport
            {
                itemId = task.itemId,
                result = "retry",
                errorMessage = "代理已连通，但该写入适配器尚未通过现场验收"
            });
        }

        private string LoadSecret(string legacyFileName)
        {
            if (_secretProvider != null) return _secretProvider(legacyFileName);
            return SecretStore.Load(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, legacyFileName));
        }

        private string LoadOptionalSecret(string legacyFileName)
        {
            if (_secretProvider != null) return _secretProvider(legacyFileName);
            var path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, legacyFileName);
            return File.Exists(path) ? SecretStore.Load(path) : null;
        }

        private void SetConnectionState(bool connected, string message)
        {
            if (_connectionState != null) _connectionState(connected, message);
        }

        private void RecordActivity(string operation, string target, bool success, string message)
        {
            if (_activity == null) return;
            _activity(new AgentActivity
            {
                OccurredAt = DateTimeOffset.Now,
                Operation = operation,
                Target = target,
                Success = success,
                Message = message
            });
        }
    }
}
