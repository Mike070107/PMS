using System;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Pms.LanGatewayAssistant
{
    internal static class FrpConfiguration
    {
        public static string Build(GatewayConfiguration value, GatewayConfigurationStore store)
        {
            if (!store.HasToken) throw new InvalidOperationException("请先导入代理连接凭据");
            var enabled = value.Routes.Where(item => item.Enabled).ToList();
            if (enabled.Count == 0) throw new InvalidOperationException("至少需要启用一个内网应用");
            if (enabled.GroupBy(item => item.RemotePort).Any(group => group.Count() > 1)) throw new InvalidOperationException("云端转发端口不能重复");
            var text = new StringBuilder();
            text.AppendLine("serverAddr = \"" + Escape(value.ServerAddress) + "\""); text.AppendLine("serverPort = " + value.ServerPort.ToString(CultureInfo.InvariantCulture)); text.AppendLine("loginFailExit = false"); text.AppendLine();
            if (store.IsManaged)
            {
                text.AppendLine("user = \"" + Escape(value.DeviceId) + "\"");
                text.AppendLine("metadatas.deviceToken = \"" + Escape(store.ReadDeviceToken()) + "\"");
            }
            text.AppendLine("auth.method = \"token\""); text.AppendLine("auth.additionalScopes = [\"HeartBeats\", \"NewWorkConns\"]");
            text.AppendLine("auth.tokenSource.type = \"file\""); text.AppendLine("auth.tokenSource.file.path = \"" + Escape(store.RuntimeTokenPath.Replace('\\', '/')) + "\""); text.AppendLine();
            text.AppendLine("transport.protocol = \"wss\""); text.AppendLine("transport.tls.enable = true"); text.AppendLine("transport.tcpMux = true"); text.AppendLine("transport.poolCount = 10"); text.AppendLine();
            text.AppendLine("log.to = \"" + Escape(store.LogPath.Replace('\\', '/')) + "\""); text.AppendLine("log.level = \"info\""); text.AppendLine("log.maxDays = 14");
            foreach (var route in enabled)
            {
                Uri origin; if (!Uri.TryCreate(route.LocalUrl, UriKind.Absolute, out origin) || origin.Scheme != "http") throw new InvalidOperationException("「" + route.Name + "」的内网地址必须是 http:// 地址");
                var port = origin.IsDefaultPort ? 80 : origin.Port;
                text.AppendLine(); text.AppendLine("[[proxies]]"); text.AppendLine("name = \"" + Escape(route.Id) + "\""); text.AppendLine("type = \"tcp\"");
                text.AppendLine("localIP = \"" + Escape(origin.Host) + "\""); text.AppendLine("localPort = " + port.ToString(CultureInfo.InvariantCulture)); text.AppendLine("remotePort = " + route.RemotePort.ToString(CultureInfo.InvariantCulture));
                text.AppendLine("transport.useEncryption = true"); text.AppendLine("transport.useCompression = true");
            }
            return text.ToString();
        }
        private static string Escape(string value) { return (value ?? String.Empty).Replace("\\", "\\\\").Replace("\"", "\\\""); }
    }
}
