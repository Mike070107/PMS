using System;
using System.IO;
using System.Security.Cryptography;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Pms.LanGatewayAssistant
{
    internal static class SelfTest
    {
        public static void Run()
        {
            var root = Path.Combine(Path.GetTempPath(), "pms-lan-gateway-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try
            {
                var route = new GatewayRoute { Id = "finance", Name = "Finance", PublicHostname = "finance.prsznh.cn", LocalUrl = "http://192.168.1.20:8050/tplus", RemotePort = 18050, Enabled = true };
                var config = new GatewayConfiguration { DeviceId = "lan-self-test", ComputerName = "test", ServerAddress = "gateway.prsznh.cn", ServerPort = 443, Routes = new System.Collections.Generic.List<GatewayRoute> { route } };
                var store = new GatewayConfigurationStore(root, false); store.Save(config); store.SaveToken("self-test-token"); store.SaveDeviceToken("self-test-device-token"); store.WriteRuntimeToken();
                var text = FrpConfiguration.Build(config, store);
                Require(text.Contains("serverPort = 443"), "server port"); Require(text.Contains("transport.protocol = \"wss\""), "wss"); Require(text.Contains("user = \"lan-self-test\""), "device identity"); Require(text.Contains("metadatas.deviceToken = \"self-test-device-token\""), "device admission token"); Require(text.Contains("localIP = \"192.168.1.20\""), "local ip"); Require(text.Contains("localPort = 8050"), "local port"); Require(text.Contains("remotePort = 18050"), "remote port");
                var sample = new byte[] { 1, 2, 3, 4 }; var protectedValue = ProtectedData.Protect(sample, null, DataProtectionScope.LocalMachine); var roundTrip = ProtectedData.Unprotect(protectedValue, null, DataProtectionScope.LocalMachine); Require(roundTrip.Length == sample.Length, "dpapi");
            }
            finally { try { Directory.Delete(root, true); } catch { } }
        }
        public static void RenderMainWindow(string outputPath)
        {
            var root = Path.Combine(Path.GetTempPath(), "pms-lan-gateway-render-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
            try
            {
                var store = new GatewayConfigurationStore(root, false);
                store.Save(new GatewayConfiguration
                {
                    DeviceId = "lan-finance-preview",
                    ComputerName = "FINANCE-PC",
                    ServerAddress = "gateway.prsznh.cn",
                    ServerPort = 443,
                    Routes = new System.Collections.Generic.List<GatewayRoute>
                    {
                        new GatewayRoute { Id = "finance", Name = "用友财务系统", PublicHostname = "caiwu.prsznh.cn", LocalUrl = "http://192.168.110.251:8050", RemotePort = 18050, Enabled = true },
                        new GatewayRoute { Id = "warehouse", Name = "仓库管理", PublicHostname = "warehouse.prsznh.cn", LocalUrl = "http://192.168.110.88:8080", RemotePort = 18051, Enabled = true }
                    }
                });
                store.SaveDeviceToken("preview-device-token"); store.SaveToken("preview-frp-token");
                var window = new MainWindow(store); window.Width = 1180; window.Height = 760; window.WindowStartupLocation = WindowStartupLocation.Manual; window.Left = -10000; window.Top = -10000;
                window.Show(); window.UpdateLayout();
                var bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32); bitmap.Render(window);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))); using (var stream = File.Create(outputPath)) encoder.Save(stream);
                window.Close();
            }
            finally { try { Directory.Delete(root, true); } catch { } }
        }
        private static void Require(bool value, string name) { if (!value) throw new InvalidOperationException("自检失败：" + name); }
    }
}
