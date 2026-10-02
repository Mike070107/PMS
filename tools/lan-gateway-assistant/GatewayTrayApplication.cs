using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewayTrayApplication : IDisposable
    {
        private readonly App _app;
        private readonly GatewayConfigurationStore _store;
        private readonly Forms.NotifyIcon _icon;
        private readonly DispatcherTimer _timer;

        public GatewayTrayApplication(App app, GatewayConfigurationStore store)
        {
            _app = app; _store = store;
            _icon = new Forms.NotifyIcon
            {
                Icon = LoadIcon(),
                Text = "PMS 内网应用连接助手",
                Visible = true,
                ContextMenuStrip = BuildMenu()
            };
            _icon.DoubleClick += delegate { _app.Dispatcher.BeginInvoke(new Action(_app.ShowMainWindow)); };
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
            _timer.Tick += delegate { Refresh(); };
            _timer.Start(); Refresh();
        }

        private Forms.ContextMenuStrip BuildMenu()
        {
            var menu = new Forms.ContextMenuStrip();
            var open = new Forms.ToolStripMenuItem("打开 PMS 内网应用连接助手");
            open.Font = new Font(open.Font, FontStyle.Bold);
            open.Click += delegate { _app.Dispatcher.BeginInvoke(new Action(_app.ShowMainWindow)); };
            var restart = new Forms.ToolStripMenuItem("启动 / 重启后台服务");
            restart.Click += delegate
            {
                try { GatewayServiceManager.RunElevated(GatewayServiceManager.Exists() ? "--restart-service" : "--install-service"); Refresh(); }
                catch (Exception exception) { System.Windows.MessageBox.Show(exception.Message, "后台服务未启动", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Error); }
            };
            var exit = new Forms.ToolStripMenuItem("退出状态程序（后台服务继续运行）");
            exit.Click += delegate { _app.Dispatcher.BeginInvoke(new Action(_app.ExitApplication)); };
            menu.Items.Add(open); menu.Items.Add(restart); menu.Items.Add(new Forms.ToolStripSeparator()); menu.Items.Add(exit);
            return menu;
        }

        private static Icon LoadIcon()
        {
            var executable = Process.GetCurrentProcess().MainModule.FileName;
            var icon = Icon.ExtractAssociatedIcon(executable);
            if (icon == null) throw new InvalidOperationException("无法加载应用图标");
            return icon;
        }

        private void Refresh()
        {
            var status = GatewayServiceManager.IsRunning() ? "后台服务运行中" : "后台服务需要检查";
            try
            {
                if (File.Exists(_store.HealthPath))
                {
                    var health = new JavaScriptSerializer().Deserialize<GatewayHealth>(File.ReadAllText(_store.HealthPath));
                    DateTimeOffset checkedAt;
                    var fresh = DateTimeOffset.TryParse(health.CheckedAt, out checkedAt) && DateTimeOffset.Now.Subtract(checkedAt).Duration() < TimeSpan.FromMinutes(2);
                    if (fresh && health.ProcessRunning && GatewayServiceManager.IsRunning()) status = "加密隧道已连接";
                }
            }
            catch { }
            _icon.Text = ("PMS 内网应用连接助手 · " + status).Substring(0, Math.Min(63, ("PMS 内网应用连接助手 · " + status).Length));
        }

        public void Dispose()
        {
            if (_timer != null) _timer.Stop();
            if (_icon != null) { _icon.Visible = false; _icon.Dispose(); }
        }
    }
}
