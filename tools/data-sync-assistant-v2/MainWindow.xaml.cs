using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.IO;
using System.Reflection;
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
        private bool _pmsConnected;
        private bool _backgroundStartAttempted;
        public ObservableCollection<ConnectionViewModel> Connections { get; private set; }
        public ObservableCollection<ActivityViewModel> Activities { get; private set; }
        public string AppVersion { get { return Assembly.GetExecutingAssembly().GetName().Version.ToString(3); } }
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
            Closed += delegate { _statusTimer.Stop(); };
            RefreshRuntimeStatus();
            RefreshActivities();
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
            MessageBox.Show("当前助手版本：" + AppVersion + "\n\n“安装 / 更新后台服务”只会让后台服务使用当前助手版本，不会把版本号写成固定文字。要升级助手程序，请先下载新版程序再运行。", "版本信息", MessageBoxButton.OK, MessageBoxImage.Information);
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
