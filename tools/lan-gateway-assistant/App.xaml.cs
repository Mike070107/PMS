using System;
using System.Diagnostics;
using System.Net;
using System.ServiceProcess;
using System.Threading;
using System.Windows;

namespace Pms.LanGatewayAssistant
{
    public partial class App : Application
    {
        private Mutex _instance;
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
            bool created; _instance = new Mutex(true, "Local\\Pms.LanGatewayAssistant.Settings", out created);
            if (!created) { MessageBox.Show("内网代理助手已经打开。", "PMS 内网代理助手"); Shutdown(); return; }
            base.OnStartup(e);
            try { var window = new MainWindow(new GatewayConfigurationStore()); MainWindow = window; window.Show(); }
            catch (Exception exception) { MessageBox.Show("助手启动失败：" + exception.Message, "PMS 内网代理助手", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); }
        }
        private void RunAdmin(Action action) { try { action(); Shutdown(0); } catch (Exception ex) { MessageBox.Show(ex.Message, "PMS 内网代理助手", MessageBoxButton.OK, MessageBoxImage.Error); Shutdown(1); } }
        protected override void OnExit(ExitEventArgs e) { if (_instance != null) _instance.Dispose(); base.OnExit(e); }
    }
}
