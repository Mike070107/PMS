using Microsoft.Win32;
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
        private readonly GatewayConfigurationStore _store; private readonly GatewayConfiguration _configuration; private readonly DispatcherTimer _timer;
        private bool _processRunning; private string _healthMessage = "正在读取代理状态…"; private string _logPreview = "";
        public ObservableCollection<RouteViewModel> Routes { get; private set; }
        public string VersionDisplay { get { return "v" + Assembly.GetExecutingAssembly().GetName().Version.ToString(3); } }
        public string ComputerDisplay { get { return Environment.MachineName + " · " + _configuration.ServerAddress + ":" + _configuration.ServerPort; } }
        public string HeaderStatus { get { return GatewayServiceManager.IsRunning() && _processRunning ? "代理运行中" : "需要检查"; } }
        public string StatusBrush { get { return GatewayServiceManager.IsRunning() && _processRunning ? "#35A875" : "#B7832B"; } }
        public string OverviewTitle { get { if (!_store.IsManaged) return "请输入 PMS 一次性配对密钥"; if (!_store.HasToken) return "代理连接凭据需要修复"; if (!GatewayServiceManager.Exists()) return "请安装后台服务"; if (!_processRunning) return "隧道正在恢复连接"; return Routes.Count == 0 ? "等待 PMS 下发内网应用" : "内网应用正在安全转发"; } }
        public string ServiceState { get { return GatewayServiceManager.IsRunning() ? "运行中" : GatewayServiceManager.Exists() ? "已停止" : "未安装"; } }
        public string TunnelState { get { return _processRunning ? "已连接" : "未连接"; } }
        public int RouteCount { get { return Routes.Count(item => item.Enabled); } }
        public Visibility NoRoutesVisibility { get { return Routes.Count == 0 ? Visibility.Visible : Visibility.Collapsed; } }
        public Visibility EnrollmentVisibility { get { return _store.IsManaged ? Visibility.Collapsed : Visibility.Visible; } }
        public Visibility ManualConfigurationVisibility { get { return _store.IsManaged ? Visibility.Collapsed : Visibility.Visible; } }
        public Visibility ServiceActionVisibility { get { return _store.IsManaged && !GatewayServiceManager.IsRunning() ? Visibility.Visible : Visibility.Collapsed; } }
        public string ServiceActionText { get { return GatewayServiceManager.Exists() ? "启动 / 修复代理" : "安装后台服务"; } }
        public string HealthMessage { get { return _healthMessage; } }
        public string LogPreview { get { return _logPreview; } }
        public event PropertyChangedEventHandler PropertyChanged;
        internal MainWindow(GatewayConfigurationStore store)
        {
            _store = store; _configuration = store.Load(); Routes = new ObservableCollection<RouteViewModel>(_configuration.Routes.Select(item => new RouteViewModel(item))); DataContext = this; InitializeComponent();
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) }; _timer.Tick += delegate { RefreshStatus(); }; _timer.Start(); Closed += delegate { _timer.Stop(); }; RefreshStatus();
        }
        private void AddRoute_Click(object sender, RoutedEventArgs e)
        {
            var port = Enumerable.Range(18050, 100).FirstOrDefault(candidate => _configuration.Routes.All(item => item.RemotePort != candidate)); if (port == 0) { MessageBox.Show("可用的隧道端口已用完。", "无法添加", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
            var dialog = new RouteDialog(null, port) { Owner = this }; if (dialog.ShowDialog() != true) return; _configuration.Routes.Add(dialog.Result); SaveAndRestart();
        }
        private void EditRoute_Click(object sender, RoutedEventArgs e)
        {
            var id = Convert.ToString(((FrameworkElement)sender).Tag); var route = _configuration.Routes.FirstOrDefault(item => item.Id == id); if (route == null) return;
            var dialog = new RouteDialog(route, route.RemotePort) { Owner = this }; if (dialog.ShowDialog() != true) return; var index = _configuration.Routes.IndexOf(route); _configuration.Routes[index] = dialog.Result; SaveAndRestart();
        }
        private void SaveAndRestart()
        {
            _store.Save(_configuration); ReloadRoutes();
            try { if (GatewayServiceManager.Exists()) GatewayServiceManager.RunElevated("--restart-service"); }
            catch (Exception exception) { MessageBox.Show("配置已保存，但后台服务重启失败：\n\n" + exception.Message, "还差一步", MessageBoxButton.OK, MessageBoxImage.Warning); }
            RefreshStatus();
        }
        private void ReloadRoutes() { Routes.Clear(); foreach (var route in _configuration.Routes) Routes.Add(new RouteViewModel(route)); RaiseAll(); }
        private void InstallService_Click(object sender, RoutedEventArgs e) { try { GatewayServiceManager.RunElevated("--install-service"); RefreshStatus(); MessageBox.Show("后台服务已安装并启动，电脑重启后会自动运行。", "安装完成", MessageBoxButton.OK, MessageBoxImage.Information); } catch (Exception ex) { MessageBox.Show(ex.Message, "安装未完成", MessageBoxButton.OK, MessageBoxImage.Error); } }
        private void RestartService_Click(object sender, RoutedEventArgs e) { try { GatewayServiceManager.RunElevated(GatewayServiceManager.Exists() ? "--restart-service" : "--install-service"); RefreshStatus(); } catch (Exception ex) { MessageBox.Show(ex.Message, "重启未完成", MessageBoxButton.OK, MessageBoxImage.Error); } }
        private void ImportToken_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new OpenFileDialog { Title = "选择 PMS 代理连接凭据", Filter = "PMS 连接凭据|frp-token;*.token;*.txt|All files|*.*" }; if (dialog.ShowDialog() != true) return;
            try { _store.SaveToken(File.ReadAllText(dialog.FileName).Trim()); RefreshStatus(); MessageBox.Show("连接凭据已使用 Windows 本机加密保存。", "导入成功", MessageBoxButton.OK, MessageBoxImage.Information); } catch (Exception ex) { MessageBox.Show(ex.Message, "导入失败", MessageBoxButton.OK, MessageBoxImage.Error); }
        }
        private async void Enroll_Click(object sender, RoutedEventArgs e)
        {
            var code = InstallCodeBox.Text.Trim();
            if (String.IsNullOrWhiteSpace(code)) { MessageBox.Show("请输入 PMS 生成的一次性配对密钥。", "缺少配对密钥", MessageBoxButton.OK, MessageBoxImage.Information); return; }
            EnrollButton.IsEnabled = false; EnrollButton.Content = "正在连接…";
            try
            {
                await Task.Factory.StartNew(delegate { return new GatewayControlPlaneClient(_store).Enroll(code, Assembly.GetExecutingAssembly().GetName().Version.ToString(3)); });
                InstallCodeBox.Clear(); RaiseAll();
                GatewayServiceManager.RunElevated(GatewayServiceManager.Exists() ? "--restart-service" : "--install-service");
                MessageBox.Show("这台电脑已受 PMS 管理。后续新增或修改内网应用时，助手会自动领取配置。", "连接完成", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception exception) { MessageBox.Show(exception.GetBaseException().Message, "连接未完成", MessageBoxButton.OK, MessageBoxImage.Error); }
            finally { EnrollButton.IsEnabled = true; EnrollButton.Content = "连接并安装"; RefreshStatus(); }
        }
        private async void CheckUpdate_Click(object sender, RoutedEventArgs e)
        {
            UpdateButton.IsEnabled = false; UpdateButton.Content = "正在检查…";
            try { var result = await Task.Factory.StartNew(delegate { return GatewayUpdateService.CheckAndDownload(Assembly.GetExecutingAssembly().GetName().Version.ToString(3), _store.RootPath); }); if (!result.HasUpdate) { MessageBox.Show("当前已是最新版。", "检查更新", MessageBoxButton.OK, MessageBoxImage.Information); return; } if (MessageBox.Show("已下载 v" + result.Manifest.Version + "。\n\n" + result.Manifest.Notes + "\n\n现在安全更新吗？", "发现新版", MessageBoxButton.YesNo, MessageBoxImage.Information) == MessageBoxResult.Yes) GatewayUpdateService.StartApply(result.DownloadedFile, Process.GetCurrentProcess().MainModule.FileName, Process.GetCurrentProcess().Id); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "更新未完成", MessageBoxButton.OK, MessageBoxImage.Error); }
            finally { UpdateButton.IsEnabled = true; UpdateButton.Content = "检查更新"; }
        }
        private void OpenLogs_Click(object sender, RoutedEventArgs e) { Directory.CreateDirectory(Path.GetDirectoryName(_store.LogPath)); Process.Start("explorer.exe", "/select,\"" + _store.LogPath + "\""); }
        private void RefreshStatus()
        {
            _processRunning = false; _healthMessage = GatewayServiceManager.Exists() ? "等待后台服务回报…" : "后台服务尚未安装";
            try { if (File.Exists(_store.HealthPath)) { var health = new JavaScriptSerializer().Deserialize<GatewayHealth>(File.ReadAllText(_store.HealthPath)); DateTimeOffset checkedAt; var fresh = DateTimeOffset.TryParse(health.CheckedAt, out checkedAt) && DateTimeOffset.Now.Subtract(checkedAt).Duration() < TimeSpan.FromMinutes(2); _processRunning = fresh && health.ProcessRunning && GatewayServiceManager.IsRunning(); _healthMessage = health.Message + (fresh ? "" : "（状态已过期）"); } } catch { }
            try { if (File.Exists(_store.LogPath)) _logPreview = String.Join(Environment.NewLine, File.ReadAllLines(_store.LogPath).Reverse().Take(4).Reverse()); else _logPreview = "还没有运行日志。"; } catch { _logPreview = "无法读取运行日志。"; }
            RaiseAll();
        }
        private void Raise(string name) { if (PropertyChanged != null) PropertyChanged(this, new PropertyChangedEventArgs(name)); }
        private void RaiseAll() { foreach (var name in new[] { "HeaderStatus", "StatusBrush", "OverviewTitle", "ServiceState", "TunnelState", "RouteCount", "NoRoutesVisibility", "EnrollmentVisibility", "ManualConfigurationVisibility", "ServiceActionVisibility", "ServiceActionText", "HealthMessage", "LogPreview" }) Raise(name); }
    }
}
