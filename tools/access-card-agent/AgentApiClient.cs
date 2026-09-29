using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace Pms.AccessCardAgent
{
    internal sealed class AgentApiClient
    {
        public const string Version = "0.5.0";
        private readonly AgentConfig _config;
        private readonly string _token;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();

        public AgentApiClient(AgentConfig config, string token)
        {
            _config = config;
            _token = token;
        }

        public void Heartbeat(Dictionary<string, bool> capabilities)
        {
            Post("/access-card-agent/heartbeat", new Dictionary<string, object>
            {
                { "version", Version },
                { "capabilities", capabilities }
            });
        }

        public AgentTask Claim()
        {
            var result = Post("/access-card-agent/claim", new Dictionary<string, object>());
            if (!result.ContainsKey("task") || result["task"] == null) return null;
            return _json.ConvertToType<AgentTask>(result["task"]);
        }

        public LegacyHistoryTask ClaimLegacyHistory()
        {
            var result = Post("/access-card-agent/legacy-history/claim", new Dictionary<string, object>());
            if (!result.ContainsKey("task") || result["task"] == null) return null;
            return _json.ConvertToType<LegacyHistoryTask>(result["task"]);
        }

        public ParkingQueryTask ClaimParkingQuery()
        {
            var result = Post("/access-card-agent/parking/queries/claim", new Dictionary<string, object>());
            if (!result.ContainsKey("task") || result["task"] == null) return null;
            return _json.ConvertToType<ParkingQueryTask>(result["task"]);
        }

        public void Report(AgentReport report)
        {
            Post("/access-card-agent/report", report);
        }

        public void ReportLegacyHistory(LegacyHistoryReport report)
        {
            Post("/access-card-agent/legacy-history/report", report);
        }

        public void ReportParkingQuery(ParkingQueryReport report)
        {
            Post("/access-card-agent/parking/queries/report", report);
        }

        private Dictionary<string, object> Post(string path, object body)
        {
            var request = (HttpWebRequest)WebRequest.Create(_config.BaseUrl + path);
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Headers["Authorization"] = "Bearer " + _token;
            request.Headers["X-Agent-Id"] = _config.AgentId;
            request.Timeout = 15000;
            request.ReadWriteTimeout = 15000;
            var bytes = Encoding.UTF8.GetBytes(_json.Serialize(body));
            request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return _json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            }
            catch (WebException exception)
            {
                var response = exception.Response as HttpWebResponse;
                var detail = exception.Message;
                if (response != null)
                {
                    using (var reader = new StreamReader(response.GetResponseStream())) detail = reader.ReadToEnd();
                }
                throw new InvalidOperationException("PMS 接口调用失败：" + detail, exception);
            }
        }
    }

    internal sealed class AgentTask
    {
        public string action { get; set; }
        public int itemId { get; set; }
        public int batchId { get; set; }
        public int attempt { get; set; }
        public string address { get; set; }
        public string roomKey { get; set; }
        public int batchSequence { get; set; }
        public string projectPhase { get; set; }
        public string accessSystem { get; set; }
        public string icCardNo { get; set; }
        public string wgCardNo { get; set; }
        public string cardTemplateVersion { get; set; }
        public object[] targetBuildingIds { get; set; }
    }

    internal sealed class AgentReport
    {
        public int itemId { get; set; }
        public string result { get; set; }
        public string icCardNo { get; set; }
        public string legacyPersonNo { get; set; }
        public int? legacyHouseSequence { get; set; }
        public object[] controllerResults { get; set; }
        public string errorRef { get; set; }
        public string errorMessage { get; set; }
    }

    internal sealed class LegacyHistoryTask
    {
        public int snapshotId { get; set; }
        public string roomKey { get; set; }
    }

    internal sealed class LegacyHistoryReport
    {
        public int snapshotId { get; set; }
        public string result { get; set; }
        public int issuedCount { get; set; }
        public int nextSequence { get; set; }
        public List<LegacyHistoryEntry> history { get; set; }
        public string errorMessage { get; set; }
    }

    internal sealed class ParkingQueryTask
    {
        public int queryId { get; set; }
        public string term { get; set; }
    }

    internal sealed class ParkingQueryReport
    {
        public int queryId { get; set; }
        public string result { get; set; }
        public List<ParkingSearchRow> rows { get; set; }
        public string errorMessage { get; set; }
    }
}
