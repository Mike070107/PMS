using System;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.ServiceProcess;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Threading;

namespace Pms.LanGatewayAssistant
{
    public partial class MainWindow : Window, INotifyPropertyChanged
    {
        private readonly GatewayConfigurationStore _store; private GatewayConfiguration _configuration; private readonly DispatcherTimer _timer;
        private bool _processRunning; private string _healthMessage = "正在读取代理状态…"; private string _logPreview = "";
        private GatewayStability _stability;
        public ObservableCollection<RouteViewModel> Routes { get; private set; }
        public string VersionDisplay { get { return "v" + Assembly.GetExecutingAssembly().GetName().Version.ToString(3); } }
        public string ComputerDisplay { get { return "本机 " + Environment.MachineName + (_store.IsManaged ? " · 通过 " + _configuration.ServerAddress + " 加密连接" : " · 尚未接入 PMS"); } }
        public string SuggestedClientName { get { return "内网客户端-" + Environment.MachineName.Substring(Math.Max(0, Environment.MachineName.Length - 4)).ToUpperInvariant(); } }
        private bool Healthy { get { return _store.IsManaged && GatewayServiceManager.IsRunning() && (_processRunning || Routes.Count(item => item.Enabled) == 0); } }
        public string HeaderStatus { get { return !_store.IsManaged ? "未配对" : Healthy ? "运行正常" : "需要检查"; } }
        public string StatusBrush { get { return !_store.IsManaged ? "#7C8998" : Healthy ? "#14896F" : "#B86E0C"; } }
        public string HeaderBackground { get { return !_store.IsManaged ? "#F1F4F7" : Healthy ? "#E6F6F1" : "#FFF3E2"; } }
        /** 四个节点：配对 / 后台服务 / 加密隧道 / 应用连通；正常绿色打勾，有问题琥珀色感叹号，还没到这一步灰色。 */
        public System.Collections.Generic.List<StatusNode> Nodes
        {
            get
            {
                var enabled = Routes.Count(item => item.Enabled);
                var failing = Routes.Count(item => item.Failing);
                var working = Routes.Count(item => item.Working);
                var service = GatewayServiceManager.IsRunning();
                return new System.Collections.Generic.List<StatusNode>
                {
                    StatusNode.Of("配对 PMS", _store.IsManaged ? "已配对" : "未配对", _store.IsManaged ? NodeState.Ok : NodeState.Bad),
                    StatusNode.Of("后台服务", ServiceState, service ? NodeState.Ok : NodeState.Bad),
                    enabled == 0 ? StatusNode.Of("加密隧道", "暂无应用", NodeState.Idle) : StatusNode.Of("加密隧道", TunnelState, _processRunning ? NodeState.Ok : NodeState.Bad),
                    enabled == 0 ? StatusNode.Of("应用连通", "暂无应用", NodeState.Idle)
                        : failing > 0 ? StatusNode.Of("应用连通", failing + " 个连不上", NodeState.Bad)
                        : working < enabled ? StatusNode.Of("应用连通", "检测中 " + working + "/" + enabled, NodeState.Idle)
                        : StatusNode.Of("应用连通", "全部正常 " + working + "/" + enabled, NodeState.Ok),
                };
            }
        }
        /** 概览只给结论：有应用连不上就直接点名，别让人自己去扫一遍卡片。 */
        public string OverviewTitle
        {
            get
            {
                if (!_store.IsManaged) return "请输入 PMS 一次性配对密钥";
                if (!_store.HasToken) return "代理连接凭据需要修复";
                if (!GatewayServiceManager.Exists()) return "请安装后台服务";
                if (!_processRunning) return "隧道正在恢复连接";
                var enabled = Routes.Count(item => item.Enabled);
                if (enabled == 0) return Routes.Count == 0 ? "等待 PMS 下发内网应用" : "当前没有启用的内网应用";
                var failing = Routes.Where(item => item.Failing).ToList();
                if (failing.Count == 1) return "「" + failing[0].Name + "」连不上内网";
                if (failing.Count > 1) return failing.Count + " 个内网应用连不上内网";
                if (Routes.Count(item => item.Working) < enabled) return "正在完成首次连通性检测";
                return enabled == 1 ? "内网应用连通正常" : enabled + " 个内网应用全部连通正常";
            }
        }
        public string ServiceState { get { return GatewayServiceManager.IsRunning() ? "运行中" : GatewayServiceManager.Exists() ? "已停止" : "未安装"; } }
        public string TunnelState { get { return _processRunning ? "已连接" : "未连接"; } }
        public string AppHealthDisplay { get { var enabled = Routes.Count(item => item.Enabled); return enabled == 0 ? "0" : Routes.Count(item => item.Working) + "/" + enabled; } }
        public string StabilityDisplay
        {
            get
            {
                var value = GatewayStabilityLog.OverallAvailability(_stability, DateTimeOffset.Now, GatewayStabilityLog.AvailabilityWindow);
                return value == null ? "—" : RouteViewModel.Percentage(value.Value);
            }
        }
        public string StabilitySummary
        {
            get
            {
                if (!_store.IsManaged) return "完成配对后，本机会自动领取 PMS 下发的内网应用并持续自检。";
                var value = GatewayStabilityLog.OverallAvailability(_stability, DateTimeOffset.Now, GatewayStabilityLog.AvailabilityWindow);
                var head = value == null
                    ? "后台服务还没有积累足够的检测记录，稍后显示最近 1 小时可用率。"
                    : "最近 1 小时整体可用率 " + RouteViewModel.Percentage(value.Value) + "。";
                if (_stability == null || _stability.TunnelRestarts <= 0) return head + "加密隧道没有发生过自动重启。";
                DateTimeOffset at;
                var when = DateTimeOffset.TryParse(_stability.LastRestartAt, out at) ? "，最近一次 " + at.ToString("MM-dd HH:mm") : "";
                return head + "加密隧道累计自动重启 " + _stability.TunnelRestarts + " 次" + when + "。";
            }
        }
        public Visibility NoRoutesVisibility { get { return _store.IsManaged && Routes.Count == 0 ? Visibility.Visible : Visibility.Collapsed; } }
        public Visibility RoutesSectionVisibility { get { return Routes.Count > 0 ? Visibility.Visible : Visibility.Collapsed; } }
        public Visibility EnrollmentVisibility { get { return _store.IsManaged ? Visibility.Collapsed : Visibility.Visible; } }
        public Visibility ManagedVisibility { get { return _store.IsManaged ? Visibility.Visible : Visibility.Collapsed; } }
        public string RemovedNotice { get { return _configuration.RemovedNotice; } }
        public Visibility RemovedVisibility { get { return !_store.IsManaged && !String.IsNullOrWhiteSpace(_configuration.RemovedNotice) ? Visibility.Visible : Visibility.Collapsed; } }
        public Visibility ServiceActionVisibility { get { return _store.IsManaged && !GatewayServiceManager.IsRunning() ? Visibility.Visible : Visibility.Collapsed; } }
        public string ServiceActionText { get { return GatewayServiceManager.Exists() ? "启动 / 修复代理" : "安装后台服务"; } }
        public string HealthMessage { get { return _healthMessage; } }
        public string LogPreview { get { return _logPreview; } }
        public event PropertyChangedEventHandler PropertyChanged;
        internal MainWindow(GatewayConfigurationStore store)
        {
            _store = store; _configuration = store.Load(); _stability = store.LoadStability();
            Routes = new ObservableCollection<RouteViewModel>(_configuration.Routes.Select(item => new RouteViewModel(item, GatewayStabilityLog.Find(_stability, item)))); DataContext = this; InitializeComponent();
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) }; _timer.Tick += delegate { RefreshStatus(); }; _timer.Start(); Closed += delegate { _timer.Stop(); }; RefreshStatus();
        }
        private RouteViewModel ModelOf(object sender)
        {
            var id = Convert.ToString(((FrameworkElement)sender).Tag);
            return Routes.FirstOrDefault(item => String.Equals(item.Id, id, StringComparison.Ordinal));
        }
        /** 测试结果写回卡片本身；弹窗一关就什么都看不见了，排障时等于没测。 */
        private async void TestRoute_Click(object sender, RoutedEventArgs e)
        {
            var model = ModelOf(sender); if (model == null) return; var route = model.Model;
            var button = sender as System.Windows.Controls.Button; if (button != null) button.IsEnabled = false;
            model.BeginTest();
            try
            {
                var report = await Task.Factory.StartNew(delegate { return new GatewayControlPlaneClient(_store).TestRoute(route); });
                model.EndTest(report.Message + "（刚刚手动测试）");
            }
            catch (Exception exception) { model.EndTest("测试没能完成：" + exception.GetBaseException().Message); }
            finally { if (button != null) button.IsEnabled = true; RaiseAll(); }
        }
        private void OpenSite_Click(object sender, RoutedEventArgs e)
        {
            var model = ModelOf(sender); if (model == null) return;
            Uri target;
            if (String.IsNullOrWhiteSpace(model.PublicHostname) || !Uri.TryCreate("https://" + model.PublicHostname.Trim(), UriKind.Absolute, out target) || target.Scheme != Uri.UriSchemeHttps)
            { MessageBox.Show("这个内网应用还没有可用的公网域名。", "无法打开", MessageBoxButton.OK, MessageBoxImage.Information); return; }
            try { Process.Start(target.AbsoluteUri); }
            catch (Exception exception) { MessageBox.Show(exception.Message, "无法打开浏览器", MessageBoxButton.OK, MessageBoxImage.Error); }
        }
        private void ReloadRoutes() { Routes.Clear(); foreach (var route in _configuration.Routes) Routes.Add(new RouteViewModel(route, GatewayStabilityLog.Find(_stability, route))); RaiseAll(); }
        private void InstallService_Click(object sender, RoutedEventArgs e) { try { GatewayServiceManager.RunElevated("--install-service"); RefreshStatus(); MessageBox.Show("后台服务已安装并启动，电脑重启后会自动运行。", "安装完成", MessageBoxButton.OK, MessageBoxImage.Information); } catch (Exception ex) { MessageBox.Show(ex.Message, "安装未完成", MessageBoxButton.OK, MessageBoxImage.Error); } }
        private void RestartService_Click(object sender, RoutedEventArgs e) { try { GatewayServiceManager.RunElevated(GatewayServiceManager.Exists() ? "--restart-service" : "--install-service"); RefreshStatus(); } catch (Exception ex) { MessageBox.Show(ex.Message, "重启未完成", MessageBoxButton.OK, MessageBoxImage.Error); } }
        private async void Enroll_Click(object sender, RoutedEventArgs e)
        {
            var code = InstallCodeBox.Text.Trim();
            if (String.IsNullOrWhiteSpace(code)) { MessageBox.Show("请输入 PMS 生成的一次性配对密钥。", "缺少配对密钥", MessageBoxButton.OK, MessageBoxImage.Information); return; }
            EnrollButton.IsEnabled = false; EnrollButton.Content = "正在连接…";
            try
            {
                var clientName = ClientNameBox.Text.Trim();
                if (String.IsNullOrWhiteSpace(clientName)) { MessageBox.Show("请填写客户端名称。", "缺少客户端名称", MessageBoxButton.OK, MessageBoxImage.Information); return; }
                await Task.Factory.StartNew(delegate { return new GatewayControlPlaneClient(_store).Enroll(code, Assembly.GetExecutingAssembly().GetName().Version.ToString(3), clientName); });
                InstallCodeBox.Clear(); RaiseAll();
                GatewayServiceManager.RunElevated(GatewayServiceManager.Exists() ? "--restart-service" : "--install-service");
                _configuration = _store.Load(); ReloadRoutes();
                MessageBox.Show("这台电脑已接入 PMS。网页上会显示已连上，之后发布到这台电脑的内网应用会自动同步过来。", "连接完成", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception exception) { MessageBox.Show(exception.GetBaseException().Message, "连接未完成", MessageBoxButton.OK, MessageBoxImage.Error); }
            finally { EnrollButton.IsEnabled = true; EnrollButton.Content = "连接"; RefreshStatus(); }
        }
        private async void CheckUpdate_Click(object sender, RoutedEventArgs e)
        {
            UpdateButton.IsEnabled = false; UpdateButton.Content = "正在检查…";
            try
            {
                var result = await Task.Factory.StartNew(delegate { return GatewayUpdateService.CheckAndDownload(Assembly.GetExecutingAssembly().GetName().Version.ToString(3), _store.RootPath); });
                if (!result.HasUpdate) { MessageBox.Show("当前已是最新版。", "检查更新", MessageBoxButton.OK, MessageBoxImage.Information); return; }
                if (MessageBox.Show("已下载 v" + result.Manifest.Version + "。\n\n" + result.Manifest.Notes + "\n\n现在安全更新吗？", "发现新版", MessageBoxButton.YesNo, MessageBoxImage.Information) == MessageBoxResult.Yes)
                {
                    GatewayUpdateService.StartApply(result.DownloadedFile, Process.GetCurrentProcess().MainModule.FileName, Process.GetCurrentProcess().Id);
                    var app = Application.Current as App; if (app != null) app.ExitApplication();
                }
            }
            catch (Exception ex) { MessageBox.Show(ex.Message, "更新未完成", MessageBoxButton.OK, MessageBoxImage.Error); }
            finally { UpdateButton.IsEnabled = true; UpdateButton.Content = "检查更新"; }
        }
        private void OpenLogs_Click(object sender, RoutedEventArgs e) { var folder = Path.GetDirectoryName(_store.LogPath); Directory.CreateDirectory(folder); Process.Start("explorer.exe", "\"" + folder + "\""); }
        private void RefreshStatus()
        {
            try { _stability = _store.LoadStability(); } catch { }
            try
            {
                var latest = _store.Load();
                var currentRoutes = String.Join("|", _configuration.Routes.Select(item => item.Id + ":" + item.LocalUrl + ":" + item.RemotePort + ":" + item.Enabled));
                var latestRoutes = String.Join("|", latest.Routes.Select(item => item.Id + ":" + item.LocalUrl + ":" + item.RemotePort + ":" + item.Enabled));
                if (latest.AppliedRevision != _configuration.AppliedRevision || latest.DeviceId != _configuration.DeviceId || !String.Equals(currentRoutes, latestRoutes, StringComparison.Ordinal)) { _configuration = latest; ReloadRoutes(); }
                else _configuration.RemovedNotice = latest.RemovedNotice;
            }
            catch { }
            _processRunning = false; _healthMessage = GatewayServiceManager.Exists() ? "等待后台服务回报…" : "后台服务尚未安装";
            try { if (File.Exists(_store.HealthPath)) { var health = new JavaScriptSerializer().Deserialize<GatewayHealth>(File.ReadAllText(_store.HealthPath)); DateTimeOffset checkedAt; var fresh = DateTimeOffset.TryParse(health.CheckedAt, out checkedAt) && DateTimeOffset.Now.Subtract(checkedAt).Duration() < TimeSpan.FromMinutes(2); _processRunning = fresh && health.ProcessRunning && GatewayServiceManager.IsRunning(); _healthMessage = health.Message + (fresh ? "" : "（状态已过期）"); } } catch { }
            try
            {
                var lines = new System.Collections.Generic.List<string>();
                if (File.Exists(_store.ActivityLogPath)) lines.AddRange(File.ReadAllLines(_store.ActivityLogPath).Reverse().Take(2).Reverse());
                if (File.Exists(_store.LogPath)) lines.AddRange(File.ReadAllLines(_store.LogPath).Reverse().Take(2).Reverse());
                _logPreview = lines.Count > 0 ? String.Join(Environment.NewLine, lines) : "还没有运行日志。";
            }
            catch { _logPreview = "无法读取运行日志。"; }
            foreach (var item in Routes) item.Apply(GatewayStabilityLog.Find(_stability, item.Model));
            RaiseAll();
        }
        private void Raise(string name) { if (PropertyChanged != null) PropertyChanged(this, new PropertyChangedEventArgs(name)); }
        private void RaiseAll() { foreach (var name in new[] { "HeaderStatus", "StatusBrush", "HeaderBackground", "Nodes", "OverviewTitle", "ServiceState", "TunnelState", "AppHealthDisplay", "StabilityDisplay", "StabilitySummary", "NoRoutesVisibility", "RoutesSectionVisibility", "EnrollmentVisibility", "ManagedVisibility", "RemovedNotice", "RemovedVisibility", "ServiceActionVisibility", "ServiceActionText", "ComputerDisplay", "HealthMessage", "LogPreview" }) Raise(name); }
    }

    public enum NodeState { Ok, Bad, Idle }
    public sealed class StatusNode
    {
        public string Title { get; private set; }
        public string Value { get; private set; }
        public string Glyph { get; private set; }
        public string Accent { get; private set; }
        public string Background { get; private set; }
        public static StatusNode Of(string title, string value, NodeState state)
        {
            return new StatusNode
            {
                Title = title, Value = value,
                Glyph = state == NodeState.Ok ? "\u2713" : state == NodeState.Bad ? "!" : "\u2026",
                Accent = state == NodeState.Ok ? "#14896F" : state == NodeState.Bad ? "#C27A12" : "#8F9CAA",
                Background = state == NodeState.Ok ? "#E9F7F2" : state == NodeState.Bad ? "#FFF4E3" : "#F2F5F8",
            };
        }
    }
}
