using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Windows.Forms;

namespace Pms.AccessCardAgent
{
    internal static class TrayApplication
    {
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr window, int command);

        public static void HideConsoleWindow()
        {
            var window = GetConsoleWindow();
            if (window != IntPtr.Zero) ShowWindow(window, 0);
        }
    }

    internal sealed class AgentTrayContext : ApplicationContext
    {
        private readonly AgentConfig _config;
        private readonly string _serviceName;
        private readonly NotifyIcon _icon;
        private readonly ToolStripMenuItem _statusItem;
        private readonly Timer _timer;
        private bool? _wasRunning;
        private bool _disposed;

        public AgentTrayContext(AgentConfig config)
        {
            _config = config;
            _serviceName = WindowsServiceInstaller.ServiceName(config);
            _statusItem = new ToolStripMenuItem("正在读取状态…") { Enabled = false };
            var menu = new ContextMenuStrip();
            menu.Items.Add(_statusItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开门禁发卡页面", null, delegate { OpenPage(); });
            menu.Items.Add("代理设置", null, delegate { OpenSettings(); });
            menu.Items.Add("启动服务", null, delegate { ChangeService(false); });
            menu.Items.Add("重启服务", null, delegate { ChangeService(true); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出状态图标", null, delegate { ExitTray(); });

            _icon = new NotifyIcon
            {
                ContextMenuStrip = menu,
                Icon = SystemIcons.Application,
                Text = "PMS 数据同步助手：正在读取状态",
                Visible = true
            };
            _icon.DoubleClick += delegate { OpenPage(); };

            _timer = new Timer { Interval = 5000 };
            _timer.Tick += delegate { RefreshStatus(); };
            _timer.Start();
            RefreshStatus();
        }

        private void RefreshStatus()
        {
            bool running;
            try
            {
                using (var service = new ServiceController(_serviceName))
                {
                    service.Refresh();
                    running = service.Status == ServiceControllerStatus.Running;
                }
            }
            catch
            {
                running = false;
            }

            var connected = running && AgentStatus.IsRecentlyConnected(Math.Max(15000, _config.PollIntervalMs * 3));
            _statusItem.Text = connected
                ? "状态：已连接 PMS"
                : running ? "状态：服务运行中，PMS 连接异常" : "状态：后台服务已停止";
            _icon.Text = connected
                ? "PMS 数据同步助手：已连接"
                : running ? "PMS 数据同步助手：连接异常" : "PMS 数据同步助手：已停止";
            _icon.Icon = connected ? SystemIcons.Information : SystemIcons.Warning;
            if (_wasRunning == true && !running)
                _icon.ShowBalloonTip(5000, "PMS 数据同步助手已停止", "右键图标可重新启动服务。", ToolTipIcon.Warning);
            _wasRunning = running;
        }

        private void ChangeService(bool restart)
        {
            try
            {
                using (var service = new ServiceController(_serviceName))
                {
                    service.Refresh();
                    if (restart && service.Status != ServiceControllerStatus.Stopped && service.Status != ServiceControllerStatus.StopPending)
                    {
                        service.Stop();
                        service.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
                    }
                    service.Refresh();
                    if (service.Status == ServiceControllerStatus.Stopped)
                    {
                        service.Start();
                        service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
                    }
                }
                RefreshStatus();
            }
            catch (Exception exception)
            {
                MessageBox.Show("操作失败：" + exception.Message + "\r\n如果是权限问题，请以管理员身份运行助手。", "PMS 数据同步助手", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void OpenPage()
        {
            Process.Start(new ProcessStartInfo { FileName = "https://prsznh.cn/access-cards", UseShellExecute = true });
        }

        private static void OpenSettings()
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Process.GetCurrentProcess().MainModule.FileName,
                UseShellExecute = true
            });
        }

        private void ExitTray()
        {
            ExitThread();
        }

        protected override void ExitThreadCore()
        {
            DisposeTrayIcon();
            base.ExitThreadCore();
        }

        private void DisposeTrayIcon()
        {
            if (_disposed) return;
            _disposed = true;
            _timer.Stop();
            _timer.Dispose();
            _icon.Visible = false;
            _icon.Dispose();
        }
    }
}
