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
            Console.WriteLine("PMS 门禁代理已启动：" + _config.Name + " / " + _config.Kind);
            while (true)
            {
                try
                {
                    var hasReader = _config.Kind != "issuer" || CardReader.HasAcr122();
                    _api.Heartbeat(BuildCapabilities(_config, hasReader));
                    if (_config.Kind == "legacy_sync")
                    {
                        var historyTask = _api.ClaimLegacyHistory();
                        if (historyTask != null)
                        {
                            HandleLegacyHistory(historyTask);
                            Thread.Sleep(_config.PollIntervalMs);
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
                Thread.Sleep(_config.PollIntervalMs);
            }
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
