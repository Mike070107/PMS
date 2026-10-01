using System;
using System.Linq;
using System.Net;
using System.Windows;

namespace Pms.LanGatewayAssistant
{
    public partial class RouteDialog : Window
    {
        private readonly GatewayRoute _existing;
        private readonly int _remotePort;
        internal GatewayRoute Result { get; private set; }
        internal RouteDialog(GatewayRoute existing, int remotePort)
        {
            InitializeComponent(); _existing = existing; _remotePort = existing == null ? remotePort : existing.RemotePort;
            if (existing != null) { NameBox.Text = existing.Name; HostnameBox.Text = existing.PublicHostname; LocalUrlBox.Text = existing.LocalUrl; EnabledBox.IsChecked = existing.Enabled; }
        }
        private void Save_Click(object sender, RoutedEventArgs e)
        {
            ErrorText.Text = String.Empty;
            try
            {
                var name = NameBox.Text.Trim(); var hostname = HostnameBox.Text.Trim().ToLowerInvariant(); var local = LocalUrlBox.Text.Trim();
                if (name.Length == 0) throw new InvalidOperationException("请填写应用名称");
                if (!hostname.EndsWith(".prsznh.cn", StringComparison.Ordinal) || hostname.Split('.').Length != 3) throw new InvalidOperationException("外网域名必须是 prsznh.cn 的一级子域名");
                Uri uri; if (!Uri.TryCreate(local, UriKind.Absolute, out uri) || uri.Scheme != "http") throw new InvalidOperationException("内网地址必须以 http:// 开头");
                EnsurePrivateHost(uri.Host); TestHttp(uri);
                Result = new GatewayRoute { Id = _existing == null ? Guid.NewGuid().ToString("N") : _existing.Id, Name = name, PublicHostname = hostname, LocalUrl = local.TrimEnd('/'), RemotePort = _remotePort, Enabled = EnabledBox.IsChecked == true };
                DialogResult = true;
            }
            catch (Exception exception) { ErrorText.Text = exception.Message; }
        }
        private static void TestHttp(Uri uri)
        {
            var request = (HttpWebRequest)WebRequest.Create(uri); request.Method = "GET"; request.Timeout = 5000; request.ReadWriteTimeout = 5000; request.AllowAutoRedirect = false;
            try { using (var response = (HttpWebResponse)request.GetResponse()) { if ((int)response.StatusCode >= 500) throw new InvalidOperationException("内网网站返回 " + (int)response.StatusCode); } }
            catch (WebException exception) { var response = exception.Response as HttpWebResponse; if (response != null && (int)response.StatusCode < 500) { response.Close(); return; } throw new InvalidOperationException("这台电脑无法打开该内网网站：" + exception.Message); }
        }
        private static void EnsurePrivateHost(string host)
        {
            IPAddress[] addresses; try { addresses = Dns.GetHostAddresses(host); } catch { throw new InvalidOperationException("无法解析内网主机地址"); }
            if (addresses.Length == 0 || addresses.Any(address => !IsPrivate(address))) throw new InvalidOperationException("内网网站必须使用局域网或本机地址，不能转发到公网 IP");
        }
        private static bool IsPrivate(IPAddress address)
        {
            if (IPAddress.IsLoopback(address)) return true; var bytes = address.GetAddressBytes();
            if (bytes.Length == 4) return bytes[0] == 10 || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) || (bytes[0] == 192 && bytes[1] == 168) || (bytes[0] == 169 && bytes[1] == 254);
            return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal;
        }
        private void Cancel_Click(object sender, RoutedEventArgs e) { DialogResult = false; }
    }
}
