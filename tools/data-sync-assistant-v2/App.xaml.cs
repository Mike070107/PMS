using System;
using System.Net;
using System.Diagnostics;
using System.Threading;
using System.Windows;
using System.ServiceProcess;

namespace Pms.DataSyncAssistant
{
    public partial class App : Application
    {
        private Mutex _instance;
        private TrayApplication _tray;

        protected override void OnStartup(StartupEventArgs e)
        {
            // The PMS production endpoint only accepts modern TLS.  .NET Framework 4.0
            // otherwise negotiates TLS 1.0 on older Windows installations, which makes
            // the local database test pass while every heartbeat fails before HTTP starts.
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2

            if (e.Args.Length > 0 && e.Args[0] == "--service")
            {
                ServiceBase.Run(new UnifiedWindowsService());
                Shutdown();
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--install-service")
            {
                try { UnifiedServiceManager.Install(); Shutdown(0); }
                catch (Exception exception) { MessageBox.Show(exception.Message, "安装后台服务", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--uninstall-service")
            {
                try { UnifiedServiceManager.Uninstall(); Shutdown(0); }
                catch (Exception exception) { MessageBox.Show(exception.Message, "卸载后台服务", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--stop-service")
            {
                try { UnifiedServiceManager.Stop(); Shutdown(0); }
                catch (Exception exception) { MessageBox.Show(exception.Message, "退出助手", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--upgrade-from-legacy")
            {
                try { UnifiedServiceManager.UpgradeFromLegacy(); Shutdown(0); }
                catch { Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--apply-product-update")
            {
                try
                {
                    UpdateManager.ApplyDownloadedUpdate(e.Args.Length > 1 ? e.Args[1] : null);
                    Shutdown(0);
                }
                catch { Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--tray-after")
            {
                int previousProcessId;
                if (e.Args.Length > 1 && Int32.TryParse(e.Args[1], out previousProcessId))
                {
                    try { Process.GetProcessById(previousProcessId).WaitForExit(15000); }
                    catch { }
                }
                StartTrayOrExit();
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--self-test")
            {
                try { SelfTest.Run(); Shutdown(0); }
                catch { Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--wizard-self-test")
            {
                try { SelfTest.RunWizardSmokeTest(); Shutdown(0); }
                catch (Exception exception)
                {
                    System.IO.File.WriteAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "PmsDataSyncAssistant-wizard-test.log"), exception.ToString());
                    Shutdown(1);
                }
                return;
            }
            if (e.Args.Length > 1 && e.Args[0] == "--render-main-window")
            {
                try { SelfTest.RenderMainWindow(e.Args[1]); Shutdown(0); }
                catch { Shutdown(1); }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--test-building3-controller")
            {
                try
                {
                    MessageBox.Show(Building3ControllerTest.Run(), "3号楼门禁验收成功", MessageBoxButton.OK, MessageBoxImage.Information);
                    Shutdown(0);
                }
                catch (Exception exception)
                {
                    MessageBox.Show(exception.Message, "3号楼门禁验收未完成", MessageBoxButton.OK, MessageBoxImage.Error);
                    Shutdown(1);
                }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--tray")
            {
                StartTrayOrExit();
                return;
            }
            bool created;
            _instance = new Mutex(true, "Local\\Pms.DataSyncAssistant.V2.Settings", out created);
            if (!created)
            {
                MessageBox.Show("PMS 数据同步助手已经打开。", "PMS 数据同步助手", MessageBoxButton.OK, MessageBoxImage.Information);
                Shutdown();
                return;
            }
            base.OnStartup(e);
            try
            {
                var store = new ConfigurationStore();
                var window = new MainWindow(store);
                MainWindow = window;
                window.Show();
            }
            catch (Exception exception)
            {
                MessageBox.Show("助手启动失败：" + exception.Message, "PMS 数据同步助手", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown(1);
            }
        }

        private void StartTrayOrExit()
        {
            bool trayCreated;
            _instance = new Mutex(true, "Local\\Pms.DataSyncAssistant.V2.Tray", out trayCreated);
            if (!trayCreated) { Shutdown(); return; }
            ShutdownMode = ShutdownMode.OnExplicitShutdown;
            _tray = new TrayApplication();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            if (_instance != null) _instance.Dispose();
            if (_tray != null) _tray.Dispose();
            base.OnExit(e);
        }
    }
}
