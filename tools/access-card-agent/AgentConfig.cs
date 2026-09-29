using System;
using System.IO;
using System.Web.Script.Serialization;

namespace Pms.AccessCardAgent
{
    internal sealed class AgentConfig
    {
        public string BaseUrl { get; set; }
        public string AgentId { get; set; }
        public string Kind { get; set; }
        public string Name { get; set; }
        public int PollIntervalMs { get; set; }
        public bool AllowSimulation { get; set; }
        public string LegacySqlServer { get; set; }
        public string LegacyDatabase { get; set; }
        public string LegacyUser { get; set; }
        public string MjSystemDatabasePath { get; set; }
        public string IcCardDatabasePath { get; set; }

        public static AgentConfig Load(string path)
        {
            if (!File.Exists(path)) throw new InvalidOperationException("找不到配置文件：" + path);
            var value = new JavaScriptSerializer().Deserialize<AgentConfig>(File.ReadAllText(path));
            if (value == null || String.IsNullOrWhiteSpace(value.BaseUrl) || String.IsNullOrWhiteSpace(value.AgentId))
                throw new InvalidOperationException("配置必须包含 BaseUrl 和 AgentId");
            if (value.PollIntervalMs < 1000) value.PollIntervalMs = 2500;
            value.BaseUrl = value.BaseUrl.TrimEnd('/');
            return value;
        }

        public static void InstallAgentId(string path, string agentId)
        {
            if (String.IsNullOrWhiteSpace(agentId))
                throw new InvalidOperationException("代理 ID 不能为空");
            var value = Load(path);
            agentId = agentId.Trim();
            if (!agentId.StartsWith(value.Kind + "-", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("代理 ID 与当前服务类型 " + value.Kind + " 不匹配");
            value.AgentId = agentId;
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(value));
        }
    }
}
