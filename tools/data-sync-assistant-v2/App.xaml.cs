using System;
using System.IO;
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

            if (e.Args.Length == 2 && e.Args[0] == "--installation-probe-service" &&
                e.Args[1].StartsWith("PmsAssistantInstallTest_", StringComparison.Ordinal))
            {
                ServiceBase.Run(new InstallationProbeService(e.Args[1])); Shutdown(); return;
            }
            if (e.Args.Length == 2 && e.Args[0] == "--installation-scm-self-test")
            {
                var root = Path.GetFullPath(e.Args[1]);
                if (!root.StartsWith(Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                    !Path.GetFileName(root).StartsWith("PmsAssistantScmTest-", StringComparison.Ordinal)) { Shutdown(2); return; }
                try { InstallationScmTest.Run(root); Shutdown(0); }
                catch (Exception error) { Directory.CreateDirectory(root); File.WriteAllText(Path.Combine(root, "scm-test-error.txt"), error.ToString()); Shutdown(1); }
                return;
            }
            try
            {
                if (ProductInstallation.ForwardLauncher(e.Args)) { Shutdown(0); return; }
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "助手启动失败", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown(1); return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--setup")
            {
                try
                {
                    var store = new ConfigurationStore();
                    var configuration = store.Load();
                    new LegacyConfigurationMigrator(store).ImportKnownLocations(configuration);
                    if (UnifiedServiceManager.HasLegacyServices()) UnifiedServiceManager.UpgradeFromLegacy();
                    else ProductInstallation.Install(ProductInstallation.CurrentExecutable);
                    MessageBox.Show("助手已安装到固定目录，后台服务本机就绪检查通过。\n\n" +
                        (ProductInstallation.ShellIntegrationWarning ?? "桌面和开始菜单均可打开助手。") +
                        "\n配置和密码已保留。联网与设备状态请查看连接卡片。",
                        "安装完成", MessageBoxButton.OK, MessageBoxImage.Information);
                    UnifiedServiceManager.StartTray();
                    Process.Start(new ProcessStartInfo { FileName = ProductInstallation.Launcher, UseShellExecute = true });
                    Shutdown(0);
                }
                catch (Exception error)
                {
                    MessageBox.Show(error.Message, "安装未完成", MessageBoxButton.OK, MessageBoxImage.Error);
                    Shutdown(1);
                }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--update-lock-test-worker")
            {
                Thread.Sleep(30000);
                Shutdown(0);
                return;
            }
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
            if (e.Args.Length > 0 && e.Args[0] == "--apply-update")
            {
                try
                {
                    if (e.Args.Length < 3) throw new InvalidOperationException("更新参数不完整");
                    int processId;
                    if (!Int32.TryParse(e.Args[2], out processId)) throw new InvalidOperationException("旧助手进程号无效");
                    // 兼容 2.5.1 及更早版本：将下载包交给统一安装事务，不再覆盖原 EXE。
                    if (e.Args.Length < 4)
                    {
                        AssistantUpdateService.StartApply(
                            Process.GetCurrentProcess().MainModule.FileName,
                            e.Args[1],
                            processId);
                        Shutdown(0);
                        return;
                    }
                    AssistantUpdateService.Apply(e.Args[1], processId, e.Args.Length > 3 ? e.Args[3] : null);
                    Shutdown(0);
                }
                catch (Exception exception)
                {
                    MessageBox.Show(exception.Message, "助手更新失败", MessageBoxButton.OK, MessageBoxImage.Error);
                    Shutdown(1);
                }
                return;
            }
            if (e.Args.Length > 0 && e.Args[0] == "--apply-product-update")
            {
                try
                {
                    UpdateManager.ApplyDownloadedUpdate(e.Args.Length > 1 ? e.Args[1] : null);
                    if (e.Args.Length > 2 && e.Args[2] == "--interactive")
                    {
                        UnifiedServiceManager.StartTray();
                        Process.Start(new ProcessStartInfo { FileName = ProductInstallation.Launcher, UseShellExecute = true });
                    }
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
                catch (Exception exception)
                {
                    try
                    {
                        System.IO.File.WriteAllText(
                            System.IO.Path.Combine(System.IO.Path.GetTempPath(), "PmsDataSyncAssistant-self-test.log"),
                            exception.ToString());
                    }
                    catch { }
                    Shutdown(1);
                }
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
            if (!ProductInstallation.IsManagedExecutable(ProductInstallation.CurrentExecutable))
            {
                if (MessageBox.Show("安装 / 升级 PMS 数据同步助手 " + UpdateManager.CurrentVersion + "？\n\n程序将安装到 Program Files 固定目录，创建桌面入口，并验证后台服务。现有配置、代理密钥和数据库密码保留在 ProgramData，不会删除。",
                    "PMS 助手安装程序", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes)
                {
                    try { Process.Start(new ProcessStartInfo { FileName = ProductInstallation.CurrentExecutable,
                        Arguments = "--setup", UseShellExecute = true, Verb = "runas" }); }
                    catch (Exception error) { MessageBox.Show("安装没有开始：" + error.Message, "安装取消", MessageBoxButton.OK, MessageBoxImage.Warning); }
                }
                Shutdown(); return;
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
