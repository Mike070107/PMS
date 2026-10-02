using System;
using System.Diagnostics;
using System.Net;
using System.ServiceProcess;
using System.Threading;
using System.Windows;
using System.ComponentModel;

namespace Pms.LanGatewayAssistant
{
    public partial class App : Application
    {
        private Mutex _instance;
        private EventWaitHandle _showSignal;
        private Thread _showThread;
        private GatewayTrayApplication _tray;
        private MainWindow _window;
        private bool _exitRequested;
        private const string InstanceName = "Local\\Pms.LanGatewayAssistant.Settings";
        private const string ShowSignalName = "Local\\Pms.LanGatewayAssistant.Show";

        internal bool ExitRequested { get { return _exitRequested; } }
        protected override void OnStartup(StartupEventArgs e)
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            if (e.Args.Length > 0 && e.Args[0] == "--service") { ServiceBase.Run(new GatewayWindowsService()); Shutdown(); return; }
            if (e.Args.Length > 0 && e.Args[0] == "--install-service") { RunAdmin(delegate { GatewayServiceManager.Install(); }); return; }
            if (e.Args.Length > 0 && e.Args[0] == "--uninstall-service") { RunAdmin(delegate { GatewayServiceManager.Uninstall(); }); return; }
            if (e.Args.Length > 0 && e.Args[0] == "--restart-service") { RunAdmin(delegate { GatewayServiceManager.Restart(); }); return; }
            if (e.Args.Length > 0 && e.Args[0] == "--apply-update")
            {
                try { GatewayUpdateService.Apply(e.Args[1], Int32.Parse(e.Args[2]), e.Args[3]); Shutdown(0); }
                catch (Exception exception) { MessageBox.Show(exception.Message, "更新未完成", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--self-test") { try { SelfTest.Run(); Shutdown(0); } catch { Shutdown(1); } return; }
            if (e.Args.Length > 1 && e.Args[0] == "--render-main-window") { try { SelfTest.RenderMainWindow(e.Args[1]); Shutdown(0); } catch { Shutdown(1); } return; }
            bool created; _instance = new Mutex(true, InstanceName, out created);
            if (!created)
            {
                try { using (var signal = EventWaitHandle.OpenExisting(ShowSignalName)) signal.Set(); } catch { }
                Shutdown(); return;
            }
            base.OnStartup(e);
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            try
            {
                _showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSignalName);
                _window = new MainWindow(new GatewayConfigurationStore());
                MainWindow = _window;
                _window.Closing += WindowClosing;
                _tray = new GatewayTrayApplication(this, new GatewayConfigurationStore());
                StartShowListener();
                if (Array.IndexOf(e.Args, "--tray") < 0) ShowMainWindow();
            }
            catch (Exception exception) { MessageBox.Show("助手启动失败：" + exception.Message, "PMS 内网应用连接助手", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
        }
        internal void ShowMainWindow()
        {
            if (_window == null) return;
            if (!_window.IsVisible) _window.Show();
            if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
            _window.Activate(); _window.Topmost = true; _window.Topmost = false; _window.Focus();
        }
        internal void ExitApplication()
        {
            _exitRequested = true;
            if (_tray != null) { _tray.Dispose(); _tray = null; }
            if (_showSignal != null) _showSignal.Set();
            if (_window != null) _window.Close();
            Shutdown();
        }
        private void WindowClosing(object sender, CancelEventArgs e)
        {
            if (_exitRequested) return;
            e.Cancel = true;
            _window.Hide();
        }
        private void StartShowListener()
        {
            _showThread = new Thread(delegate()
            {
                while (!_exitRequested)
                {
                    _showSignal.WaitOne();
                    if (!_exitRequested) Dispatcher.BeginInvoke(new Action(ShowMainWindow));
                }
            });
            _showThread.IsBackground = true; _showThread.Name = "PMS 助手窗口唤醒"; _showThread.Start();
        }
        private void RunAdmin(Action action) { try { action(); Shutdown(0); } catch (Exception ex) { MessageBox.Show(ex.Message, "PMS 内网应用连接助手", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); } }
        protected override void OnExit(ExitEventArgs e) { if (_tray != null) _tray.Dispose(); if (_showSignal != null) _showSignal.Dispose(); if (_instance != null) _instance.Dispose(); base.OnExit(e); }
    }
}
