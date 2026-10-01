using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.IO;
using System.Reflection;
using System.Diagnostics;
using System.ServiceProcess;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Pms.DataSyncAssistant
{
    public partial class MainWindow : Window, INotifyPropertyChanged
    {
        private readonly ConfigurationStore _store;
        private readonly AssistantConfiguration _configuration;
        private readonly DispatcherTimer _statusTimer;
        private readonly DispatcherTimer _updateTimer;
        private bool _pmsConnected;
        private bool _backgroundStartAttempted;
        private bool _updateInProgress;
        public ObservableCollection<ConnectionViewModel> Connections { get; private set; }
        public ObservableCollection<ActivityViewModel> Activities { get; private set; }
        public string AppVersion { get { return Assembly.GetExecutingAssembly().GetName().Version.ToString(3); } }
        public string AppVersionDisplay { get { return "v" + AppVersion; } }
        public string AssistantInfoHeader { get { return "助手信息    版本 " + AppVersion; } }
        public string ActivityHeader { get { return "最近活动    " + Activities.Count + " 条"; } }
        public bool HasActivities { get { return Activities.Count > 0; } }
        public bool HasNoActivities { get { return Activities.Count == 0; } }
        public string HostName { get { return _configuration.Host.Name; } }
        public string HostIp { get { return _configuration.Host.IpAddress; } }
        public string HostDisplay { get { return HostName + " · " + HostIp; } }
        public int ConnectionCount { get { return Connections.Count; } }
        public string ConnectionCountDisplay { get { return HostName + " 上已启用 " + ConnectionCount + " 个连接"; } }
        public bool IsPaired { get { return _pmsConnected && IsServiceRunning; } }
        public bool IsServiceRunning { get { return GetServiceRunning(); } }
        public bool AllConnectionsHealthy { get { return Connections.Count > 0 && Connections.All(item => item.IsHealthy); } }
        public string HeaderStatus { get { return IsPaired ? "PMS 已连接" : "PMS 尚未配对"; } }
        public string HeaderStatusColor { get { return IsPaired ? "#35A875" : "#8B98A6"; } }
        public string OverviewTitle
        {
            get
            {
                if (!IsPaired) return "请先连接 PMS";
                if (!IsServiceRunning) return "后台服务尚未运行";
                if (Connections.Count == 0) return "请添加第一个数据连接";
                return AllConnectionsHealthy ? "所有数据连接都正常" : "有连接需要检查";
            }
        }
        public string PmsState { get { return IsPaired ? "已连接" : "未配对"; } }
        public string CredentialState { get { return _store.HasAnySecrets ? "已加密" : "尚未保存"; } }
        public string ServiceState { get { return IsServiceRunning ? "运行中" : "未运行"; } }
        public event PropertyChangedEventHandler PropertyChanged;

        public MainWindow(ConfigurationStore store)
        {
            _store = store;
            _configuration = store.Load();
            // Every launch also repairs incomplete configuration left by an earlier preview build.
            new LegacyConfigurationMigrator(store).ImportKnownLocations(_configuration);
            Connections = new ObservableCollection<ConnectionViewModel>(
                _configuration.Connections.Select(item => new ConnectionViewModel(item)));
            Activities = new ObservableCollection<ActivityViewModel>();
            DataContext = this;
            InitializeComponent();
            _statusTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
            _statusTimer.Tick += delegate { RefreshRuntimeStatus(); };
            _statusTimer.Start();
            _updateTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
            _updateTimer.Tick += delegate { RefreshProductUpdateStatus(); };
            _updateTimer.Start();
            Closed += delegate { _statusTimer.Stop(); _updateTimer.Stop(); };
            RefreshRuntimeStatus();
            RefreshActivities();
            RefreshProductUpdateStatus();
            Loaded += delegate { EnsureBackgroundRunning(false); };
        }

        private void AddConnection_Click(object sender, RoutedEventArgs e)
        {
            var wizard = new ConnectionWizard(_configuration.Host, _store) { Owner = this };
            if (wizard.ShowDialog() != true || wizard.Result == null) return;
            _configuration.Connections.Add(wizard.Result);
            Connections.Add(new ConnectionViewModel(wizard.Result));
            _store.Save(_configuration);
            Raise("ConnectionCount");
            Raise("ConnectionCountDisplay");
            RaiseStatus();
            EnsureBackgroundRunning(true);
        }

        private void EditConnection_Click(object sender, RoutedEventArgs e)
        {
            var button = sender as Button;
            var id = button == null ? null : button.Tag as string;
            var existing = _configuration.Connections.FirstOrDefault(item => item.Id == id);
            if (existing == null) return;
            var wizard = new ConnectionWizard(_configuration.Host, _store, existing) { Owner = this };
            if (wizard.ShowDialog() != true) return;
            _store.Save(_configuration);
            var view = Connections.FirstOrDefault(item => item.Id == id);
            if (view != null) view.Refresh();
            RaiseStatus();
            EnsureBackgroundRunning(true);
        }

        private void CheckUpdate_Click(object sender, RoutedEventArgs e)
        {
            if (_updateInProgress) return;
            _updateInProgress = true;
            CheckUpdateButton.IsEnabled = false;
            CheckUpdateButton.Content = "检查中…";
            AssistantInfoExpander.IsExpanded = true;
            UpgradeProgressPanel.Visibility = Visibility.Visible;
            UpgradeProgressBar.IsIndeterminate = true;
            UpgradePercentText.Text = "";
            UpgradeStatusText.Text = "正在检查可用版本…";
            var currentVersion = AppVersion;
            var rootPath = _store.RootPath;
            Task.Factory.StartNew(delegate { return AssistantUpdateService.CheckAndDownload(currentVersion, rootPath); })
                .ContinueWith(task => Dispatcher.BeginInvoke(new Action(delegate
                {
                    _updateInProgress = false;
                    CheckUpdateButton.IsEnabled = true;
                    CheckUpdateButton.Content = "检查更新";
                    UpgradeProgressBar.IsIndeterminate = false;
                    if (task.IsFaulted)
                    {
                        var error = task.Exception == null ? "未知错误" : task.Exception.GetBaseException().Message;
                        UpgradeStatusText.Text = "检查失败：" + error;
                        UpgradePercentText.Text = "失败";
                        MessageBox.Show("没有完成更新检查，当前助手和配置没有改变。\n\n" + error + "\n\n请确认电脑可以访问更新服务，或联系管理员发布更新清单。", "检查更新失败", MessageBoxButton.OK, MessageBoxImage.Warning);
                        return;
                    }
                    var result = task.Result;
                    if (!result.HasUpdate)
                    {
                        UpgradeProgressBar.Value = 100;
                        UpgradePercentText.Text = "最新";
                        UpgradeStatusText.Text = "当前已经是最新版本 " + result.CurrentVersion;
                        MessageBox.Show("当前助手已经是最新版本：" + result.CurrentVersion, "检查更新", MessageBoxButton.OK, MessageBoxImage.Information);
                        return;
                    }
                    UpgradeProgressBar.Value = 100;
                    UpgradePercentText.Text = "完成";
                    UpgradeStatusText.Text = "已下载版本 " + result.Manifest.Version + "，等待确认安装";
                    var notes = String.IsNullOrWhiteSpace(result.Manifest.ReleaseNotes) ? "" : "\n\n更新内容：" + result.Manifest.ReleaseNotes;
                    if (MessageBox.Show("发现新版本 " + result.Manifest.Version + "（当前 " + result.CurrentVersion + "）。\n\n现在重启助手并完成安全更新吗？" + notes, "发现新版本", MessageBoxButton.YesNo, MessageBoxImage.Information) != MessageBoxResult.Yes)
                        return;
                    try
                    {
                        var target = Assembly.GetExecutingAssembly().Location;
                        AssistantUpdateService.StartApply(result.DownloadedFile, target, Process.GetCurrentProcess().Id);
                        UpgradeStatusText.Text = "正在退出并替换程序，请稍候…";
                        // Close the WPF window and terminate this process explicitly. The
                        // elevated updater waits for this PID before touching the EXE.
                        Application.Current.Shutdown();
                    }
                    catch (Exception exception)
                    {
                        UpgradeStatusText.Text = "安装失败：" + exception.Message;
                        MessageBox.Show("更新包已经下载，但没有开始替换程序。\n\n" + exception.Message, "安装更新失败", MessageBoxButton.OK, MessageBoxImage.Error);
                    }
                })), System.Threading.Tasks.TaskScheduler.Default);
        }

        private void OpenNewVersion_Click(object sender, RoutedEventArgs e)
        {
            var state = UpdateManager.GetState();
            if (state == null || String.IsNullOrWhiteSpace(state.InstalledExecutable) || !File.Exists(state.InstalledExecutable))
            {
                RefreshProductUpdateStatus();
                return;
            }
            UnifiedServiceManager.InstallTrayStartupForCurrentUser(state.InstalledExecutable);
            Process.Start(new ProcessStartInfo { FileName = state.InstalledExecutable, UseShellExecute = true });
            Close();
        }

        private void RefreshProductUpdateStatus()
        {
            var state = UpdateManager.GetState();
            if (state == null)
            {
                ProductUpdateTitle.Text = "自动更新已开启";
                ProductUpdateDetail.Text = "后台服务每 6 小时自动检查；更新时这个窗口可继续使用。";
                ProductUpdateStage.Text = "等待后台首次检查 · v" + AppVersion;
                ProductUpdatePercent.Text = "";
                ProductUpdateProgress.Value = 0;
                CheckUpdateButton.Content = "检查更新";
                OpenNewVersionButton.Visibility = Visibility.Collapsed;
                return;
            }

            ProductUpdateProgress.IsIndeterminate = false;
            ProductUpdateProgress.Value = state.Percent;
            ProductUpdatePercent.Text = state.Phase == "failed" ? "未完成" : state.Percent + "%";
            ProductUpdateStage.Text = StateLabel(state.Phase);
            ProductUpdateTitle.Text = String.IsNullOrWhiteSpace(state.Message) ? "自动更新" : state.Message;
            ProductUpdateDetail.Text = state.Phase == "failed" && !String.IsNullOrWhiteSpace(state.Error)
                ? state.Error + "；已保留现有版本，可点击右上角重试。"
                : VersionDetail(state);
            CheckUpdateButton.Content = state.Phase == "failed" ? "重试更新" : state.Phase == "current" ? "已是最新" : "检查更新";

            var canOpen = state.Phase == "installed" && !String.IsNullOrWhiteSpace(state.InstalledExecutable) &&
                UpdateManager.IsVersionAtLeast(state.InstalledVersion, AppVersion) && File.Exists(state.InstalledExecutable) &&
                !String.Equals(Path.GetFullPath(state.InstalledExecutable),
                    Path.GetFullPath(Process.GetCurrentProcess().MainModule.FileName), StringComparison.OrdinalIgnoreCase);
            OpenNewVersionButton.Visibility = canOpen ? Visibility.Visible : Visibility.Collapsed;
            if (canOpen) UnifiedServiceManager.InstallTrayStartupForCurrentUser(state.InstalledExecutable);
        }

        private static string StateLabel(string phase)
        {
            if (phase == "checking") return "正在检查";
            if (phase == "downloading") return "正在下载";
            if (phase == "verifying") return "安全校验";
            if (phase == "installing") return "正在切换";
            if (phase == "installed") return "更新完成";
            if (phase == "failed") return "更新未完成";
            return "已是最新";
        }

        private string VersionDetail(ProductUpdateState state)
        {
            if (state.Phase == "installed" && !String.IsNullOrWhiteSpace(state.InstalledVersion))
                return "后台服务已升级到 v" + state.InstalledVersion + "。当前窗口仍是 v" + AppVersion + "，不影响同步。";
            if (!String.IsNullOrWhiteSpace(state.TargetVersion))
                return "当前 v" + AppVersion + " · 目标 v" + state.TargetVersion + "；下载、校验和切换都在后台完成。";
            return "当前窗口 v" + AppVersion + "；后台会按时自动检查新版。";
        }

        private void UninstallService_Click(object sender, RoutedEventArgs e)
        {
            if (!UnifiedServiceManager.Exists())
            {
                MessageBox.Show("本机没有安装 PMS 数据连接后台服务。保存的连接和密码未受影响。", "卸载本机连接服务", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            if (MessageBox.Show("将停止并卸载本机唯一的数据连接服务。保存的连接和加密密码会保留，之后可以重新安装。", "确认卸载本机连接服务", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
            try { UnifiedServiceManager.RunElevated("--uninstall-service"); RaiseStatus(); MessageBox.Show("本机连接服务已卸载，配置和密码仍然保留。", "卸载完成", MessageBoxButton.OK, MessageBoxImage.Information); }
            catch (Exception exception) { MessageBox.Show(exception.Message, "卸载失败", MessageBoxButton.OK, MessageBoxImage.Error); }
        }

        private void InstallService_Click(object sender, RoutedEventArgs e)
        {
            InstallServiceButton.IsEnabled = false;
            InstallServiceButton.Content = "正在更新…";
            UpgradeProgressPanel.Visibility = Visibility.Visible;
            UpgradeProgressBar.Value = 2;
            UpgradePercentText.Text = "2%";
            UpgradeStatusText.Text = "正在请求 Windows 管理员授权…";
            UnifiedServiceManager.ResetUpgradeProgress();
            var operation = Task.Factory.StartNew(delegate { UnifiedServiceManager.RunElevated("--upgrade-from-legacy"); });
            var progressTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(350) };
            progressTimer.Tick += delegate
            {
                var progress = UnifiedServiceManager.GetUpgradeProgress();
                if (progress != null)
                {
                    UpgradeProgressBar.Value = progress.Percent;
                    UpgradePercentText.Text = progress.Percent + "%";
                    UpgradeStatusText.Text = progress.Message;
                }
                if (!operation.IsCompleted) return;
                progressTimer.Stop();
                InstallServiceButton.IsEnabled = true;
                InstallServiceButton.Content = "安装 / 更新后台服务";
                if (operation.IsFaulted)
                {
                    var exception = operation.Exception == null ? new InvalidOperationException("未知错误") : operation.Exception.GetBaseException();
                    UpgradeStatusText.Text = "更新未完成：" + exception.Message;
                    UpgradePercentText.Text = "失败";
                    MessageBox.Show("后台服务更新未完成，现有配置不会丢失。\n\n" + exception.Message, "更新未完成", MessageBoxButton.OK, MessageBoxImage.Error);
                    return;
                }
                UpgradeProgressBar.Value = 100;
                UpgradePercentText.Text = "100%";
                UpgradeStatusText.Text = "后台服务已更新并验证在线";
                RefreshRuntimeStatus();
            };
            progressTimer.Start();
        }

        private void EnsureBackgroundRunning(bool forceRestart)
        {
            if (_backgroundStartAttempted && !forceRestart)
            {
                UnifiedServiceManager.StartTray();
                return;
            }
            var ready = _configuration.Connections.Any(delegate(ConnectionConfiguration item)
            {
                string error;
                return item.Enabled && ConnectionAgentRuntime.CanStart(item, _store, out error);
            });
            if (!ready) return;
            _backgroundStartAttempted = true;
            try
            {
                if (forceRestart || !IsServiceRunning) UnifiedServiceManager.RunElevated("--install-service");
                else UnifiedServiceManager.StartTray();
                RefreshRuntimeStatus();
            }
            catch (Exception exception)
            {
                MessageBox.Show("连接参数已经保存，但后台服务尚未启动，因此网页仍会显示未接入，右下角也不会出现状态图标。\n\n" + exception.Message + "\n\n请重新打开助手并允许 Windows 管理员授权。", "还差一步：启动后台服务", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private void UninstallSoftware_Click(object sender, RoutedEventArgs e)
        {
            MessageBox.Show("正式卸载器尚未接入。本操作默认保留 ProgramData 中的连接和加密配置。", "卸载此软件", MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        private void Raise(string name)
        {
            if (PropertyChanged != null) PropertyChanged(this, new PropertyChangedEventArgs(name));
        }

        private void RaiseStatus()
        {
            Raise("IsPaired"); Raise("IsServiceRunning"); Raise("AllConnectionsHealthy");
            Raise("HeaderStatus"); Raise("HeaderStatusColor"); Raise("OverviewTitle");
            Raise("PmsState"); Raise("CredentialState"); Raise("ServiceState");
        }

        private void RefreshRuntimeStatus()
        {
            var anyPmsConnected = false;
            try
            {
                var path = Path.Combine(_store.RootPath, "health.json");
                if (File.Exists(path))
                {
                    var root = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)) as System.Collections.Generic.Dictionary<string, object>;
                    var values = root == null || !root.ContainsKey("connections") ? null : root["connections"] as object[];
                    DateTimeOffset checkedAt;
                    var fresh = root.ContainsKey("checkedAt") && DateTimeOffset.TryParse(Convert.ToString(root["checkedAt"]), out checkedAt)
                        && DateTimeOffset.Now.Subtract(checkedAt).Duration() < TimeSpan.FromMinutes(2);
                    if (values != null && fresh && IsServiceRunning)
                    {
                        foreach (var value in values)
                        {
                            var state = value as System.Collections.Generic.Dictionary<string, object>;
                            if (state == null || !state.ContainsKey("id")) continue;
                            var model = _configuration.Connections.FirstOrDefault(item => item.Id == Convert.ToString(state["id"]));
                            if (model == null) continue;
                            var local = state.ContainsKey("localHealthy") && Convert.ToBoolean(state["localHealthy"]);
                            var online = state.ContainsKey("pmsConnected") && Convert.ToBoolean(state["pmsConnected"]);
                            if (online) anyPmsConnected = true;
                            model.Status = online && local ? "在线" : local ? "PMS 未连接" : "连接异常";
                            model.StatusTone = online && local ? "ok" : local ? "warning" : "error";
                            if (state.ContainsKey("message")) model.Summary = Convert.ToString(state["message"]);
                            var view = Connections.FirstOrDefault(item => item.Id == model.Id);
                            if (view != null) view.Refresh();
                        }
                    }
                }
            }
            catch { }
            _pmsConnected = anyPmsConnected;
            RaiseStatus();
            RefreshActivities();
        }

        private void RefreshActivities()
        {
            var records = ActivityStore.Load(_store.RootPath).Take(20).ToList();
            Activities.Clear();
            foreach (var record in records) Activities.Add(new ActivityViewModel(record));
            Raise("ActivityHeader");
            Raise("HasActivities");
            Raise("HasNoActivities");
        }

        private static bool GetServiceRunning()
        {
            try
            {
                using (var service = new ServiceController("PmsDataSyncAssistant"))
                    return service.Status == ServiceControllerStatus.Running;
            }
            catch { return false; }
        }
    }
}
