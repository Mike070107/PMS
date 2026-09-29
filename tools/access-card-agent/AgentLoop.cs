using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Pms.AccessCardAgent
{
    internal sealed class AgentLoop
    {
        private readonly AgentConfig _config;
        private readonly AgentApiClient _api;

        public AgentLoop(AgentConfig config, AgentApiClient api)
        {
            _config = config;
            _api = api;
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
                    _api.Heartbeat(BuildCapabilities(_config, hasReader));
                    AgentStatus.MarkConnected();
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
                    var task = _api.Claim();
                    if (task != null) Handle(task, hasReader);
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine(DateTime.Now.ToString("s") + " " + exception.Message);
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
            return new Dictionary<string, bool>
            {
                { "pcscReader", hasReader },
                { "cardWrite", false },
                { "legacyDbRead", config.Kind == "legacy_sync" },
                { "legacyDbWrite", false },
                { "accessDbRead", config.Kind == "access_gateway" },
                { "accessDbWrite", false },
                { "controllerUpload", false }
            };
        }

        private void HandleLegacyHistory(LegacyHistoryTask task)
        {
            try
            {
                var passwordPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "legacy-db-password.dat");
                var result = LegacyDatabase.GetHistory(_config, SecretStore.Load(passwordPath), task.roomKey);
                _api.ReportLegacyHistory(new LegacyHistoryReport
                {
                    snapshotId = task.snapshotId,
                    result = "success",
                    issuedCount = result.issuedCount,
                    nextSequence = result.nextSequence,
                    history = result.history
                });
            }
            catch (Exception exception)
            {
                _api.ReportLegacyHistory(new LegacyHistoryReport
                {
                    snapshotId = task.snapshotId,
                    result = "retry",
                    errorMessage = exception.Message
                });
            }
        }

        private void HandleLegacyCardCheck(LegacyCardCheckTask task)
        {
            try
            {
                var passwordPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "legacy-db-password.dat");
                var matches = LegacyDatabase.FindCard(_config, SecretStore.Load(passwordPath), task.icCardNo);
                _api.ReportLegacyCardCheck(new LegacyCardCheckReport
                {
                    checkId = task.checkId,
                    result = "success",
                    matches = matches
                });
            }
            catch (Exception exception)
            {
                _api.ReportLegacyCardCheck(new LegacyCardCheckReport
                {
                    checkId = task.checkId,
                    result = "retry",
                    errorMessage = exception.Message
                });
            }
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
            // 默认拒绝产生真实副作用；硬件和旧库适配器通过验收后逐项替换此分支。
            _api.Report(new AgentReport
            {
                itemId = task.itemId,
                result = "retry",
                errorMessage = "代理已连通，但该写入适配器尚未通过现场验收"
            });
        }
    }
}
