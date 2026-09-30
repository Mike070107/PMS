using System;
using System.Threading;
using System.Windows;
using System.ServiceProcess;

namespace Pms.DataSyncAssistant
{
    public partial class App : Application
    {
        private Mutex _instance;

        protected override void OnStartup(StartupEventArgs e)
        {
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
            if (e.Args.Length > 0 && e.Args[0] == "--self-test")
            {
                try { SelfTest.Run(); Shutdown(0); }
                catch { Shutdown(1); }
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

        protected override void OnExit(ExitEventArgs e)
        {
            if (_instance != null) _instance.Dispose();
            base.OnExit(e);
        }
    }
}
