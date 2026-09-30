using System;
using System.IO;
using System.Text.RegularExpressions;
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
        public string ParkingSqlServer { get; set; }
        public string ParkingPhase1Database { get; set; }
        public string ParkingPhase2Database { get; set; }
        public string ParkingUser { get; set; }

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

        public static AgentConfig CreateDefaults(string kind)
        {
            return new AgentConfig
            {
                BaseUrl = "https://prsznh.cn/api/v1",
                AgentId = "",
                Kind = kind,
                Name = kind == "legacy_sync" ? "192.168.1.80 旧库同步"
                    : kind == "access_gateway" ? "192.168.1.88 门禁网关"
                    : kind == "parking_gateway" ? "枫桦景苑停车系统网关" : "前台发卡电脑",
                PollIntervalMs = 2500,
                AllowSimulation = false,
                LegacySqlServer = kind == "legacy_sync" ? "192.168.1.80" : "",
                LegacyDatabase = kind == "legacy_sync" ? "JS0131625" : "",
                LegacyUser = kind == "legacy_sync" ? "SA" : "",
                MjSystemDatabasePath = kind == "access_gateway"
                    ? "C:\\Users\\Port1\\AppData\\Local\\VirtualStore\\Program Files (x86)\\MjSystem\\Database\\ChineseSimple\\MJDataBase.mdb" : "",
                IcCardDatabasePath = kind == "access_gateway"
                    ? "C:\\Users\\Port1\\AppData\\Local\\VirtualStore\\Program Files (x86)\\iCCard\\iCCard.mdb" : "",
                ParkingSqlServer = kind == "parking_gateway" ? "192.168.6.3" : "",
                ParkingPhase1Database = kind == "parking_gateway" ? "parking1" : "",
                ParkingPhase2Database = kind == "parking_gateway" ? "parking2" : "",
                ParkingUser = ""
            };
        }

        public static string NormalizeAgentId(string input)
        {
            if (String.IsNullOrWhiteSpace(input)) return "";
            var match = Regex.Match(input, "(?:issuer|access_gateway|legacy_sync|parking_gateway)-[a-fA-F0-9]{16}");
            return match.Success ? match.Value : input.Trim();
        }

        public static bool TryParseConnectionKey(string input, out string agentId, out string token)
        {
            agentId = "";
            token = "";
            if (String.IsNullOrWhiteSpace(input)) return false;
            input = input.Trim();
            var separator = input.IndexOf('.');
            if (separator <= 0 || separator >= input.Length - 1) return false;
            var candidate = NormalizeAgentId(input.Substring(0, separator));
            if (!Regex.IsMatch(candidate, "^(?:issuer|access_gateway|legacy_sync|parking_gateway)-[a-fA-F0-9]{16}$")) return false;
            agentId = candidate;
            token = input.Substring(separator + 1);
            return token.Length >= 20;
        }

        public static void Save(string path, AgentConfig value)
        {
            if (value == null || String.IsNullOrWhiteSpace(value.Kind))
                throw new InvalidOperationException("请选择服务类型");
            value.AgentId = NormalizeAgentId(value.AgentId);
            if (!value.AgentId.StartsWith(value.Kind + "-", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("代理 ID 与当前服务类型不匹配，请从 PMS 页面重新复制对应电脑的代理 ID");
            if (String.IsNullOrWhiteSpace(value.Name))
                throw new InvalidOperationException("电脑名称不能为空");
            if (value.Kind == "parking_gateway" &&
                (String.IsNullOrWhiteSpace(value.ParkingSqlServer) ||
                 String.IsNullOrWhiteSpace(value.ParkingPhase1Database) ||
                 String.IsNullOrWhiteSpace(value.ParkingPhase2Database) ||
                 String.IsNullOrWhiteSpace(value.ParkingUser)))
                throw new InvalidOperationException("停车网关必须填写 SQL Server、一期库、二期库和数据库用户");
            value.BaseUrl = "https://prsznh.cn/api/v1";
            if (value.PollIntervalMs < 1000) value.PollIntervalMs = 2500;
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(value));
        }
    }
}
