using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Pms.DataSyncAssistant
{
    public partial class ConnectionWizard : Window
    {
        private readonly HostConfiguration _host;
        private readonly ConfigurationStore _store;
        private readonly ConnectionConfiguration _editing;
        private int _step = 1;
        private string _type = ConnectionTypes.Parking;
        public ConnectionConfiguration Result { get; private set; }

        public ConnectionWizard(HostConfiguration host, ConfigurationStore store, ConnectionConfiguration editing = null)
        {
            _host = host;
            _store = store;
            _editing = editing;
            InitializeComponent();
            if (editing != null)
            {
                Title = "设置数据连接";
                _type = editing.Type;
                ParkingType.IsChecked = _type == ConnectionTypes.Parking;
                LegacyAccessType.IsChecked = _type == ConnectionTypes.LegacyAccess;
                BuildingAccessType.IsChecked = _type == ConnectionTypes.BuildingAccess;
                CardReaderType.IsChecked = _type == ConnectionTypes.CardReader;
            }
            ApplyDefaults();
        }

        private void Type_Checked(object sender, RoutedEventArgs e)
        {
            var radio = sender as RadioButton;
            if (radio == null || radio.Tag == null || !IsInitialized) return;
            _type = radio.Tag.ToString();
            ApplyDefaults();
        }

        private void ApplyDefaults()
        {
            var existing = _editing;
            if (existing != null)
            {
                NameInput.Text = existing.Name;
                ServerInput.Text = Get(existing, "server");
                UserInput.Text = Get(existing, "user");
                DatabaseOneInput.Text = Get(existing, "database1");
                DatabaseTwoInput.Text = Get(existing, "database2");
                MovementServerOneInput.Text = Get(existing, "movementServer1");
                MovementDatabaseOneInput.Text = Get(existing, "movementDatabase1");
                MovementServerTwoInput.Text = Get(existing, "movementServer2");
                MovementDatabaseTwoInput.Text = Get(existing, "movementDatabase2");
                MovementUserInput.Text = Get(existing, "movementUser");
                MovementPasswordHint.Text = _store.HasSecret(ConnectionAgentRuntime.MovementPasswordKey(existing))
                    ? "历史库密码已安全保存，留空保持不变。" : "留空沿用车辆数据库密码。";
                MjSystemPathInput.Text = Get(existing, "mjSystemPath");
                IcCardPathInput.Text = Get(existing, "icCardPath");
                PasswordHint.Text = _store.HasSecret("connection:" + existing.Id + ":password")
                    ? "密码已安全保存，留空保持不变。" : "请输入数据库密码。";
                AgentCredentialHint.Text = _store.HasSecret(ConnectionAgentRuntime.TokenKey(existing))
                    ? "PMS 连接密钥已安全保存，留空保持不变。" : "请粘贴 PMS 页面生成的一次性连接密钥。";
                UpdateFieldVisibility();
                return;
            }
            if (_type == ConnectionTypes.Parking)
            {
                NameInput.Text = "枫桦景苑停车系统"; ServerInput.Text = "192.168.6.3"; UserInput.Text = "sa"; DatabaseOneInput.Text = "parking1"; DatabaseTwoInput.Text = "parking2";
            }
            else if (_type == ConnectionTypes.LegacyAccess)
            {
                NameInput.Text = "枫桦一二期小区大门门禁系统接入"; ServerInput.Text = "192.168.1.80"; UserInput.Text = "SA"; DatabaseOneInput.Text = "JS0131625"; DatabaseTwoInput.Text = "";
            }
            else if (_type == ConnectionTypes.BuildingAccess)
            {
                NameInput.Text = "枫桦二期楼栋门禁系统接入";
                MjSystemPathInput.Text = @"C:\Users\Port1\AppData\Local\VirtualStore\Program Files (x86)\MjSystem\Database\ChineseSimple\MJDataBase.mdb";
                IcCardPathInput.Text = @"C:\Users\Port1\AppData\Local\VirtualStore\Program Files (x86)\iCCard\iCCard.mdb";
            }
            else
            {
                NameInput.Text = "办公室发卡器"; ReaderInput.Text = "将由正式设备适配器自动检测";
            }
            UpdateFieldVisibility();
        }

        private void UpdateFieldVisibility()
        {
            var isSql = _type == ConnectionTypes.Parking || _type == ConnectionTypes.LegacyAccess;
            var isFile = _type == ConnectionTypes.BuildingAccess;
            var isReader = _type == ConnectionTypes.CardReader;
            SqlFields.Visibility = isSql ? Visibility.Visible : Visibility.Collapsed;
            DatabaseFields.Visibility = isSql ? Visibility.Visible : Visibility.Collapsed;
            MovementFields.Visibility = _type == ConnectionTypes.Parking ? Visibility.Visible : Visibility.Collapsed;
            FileFields.Visibility = isFile ? Visibility.Visible : Visibility.Collapsed;
            ReaderFields.Visibility = isReader ? Visibility.Visible : Visibility.Collapsed;
            PasswordLabel.Visibility = isReader ? Visibility.Collapsed : Visibility.Visible;
            PasswordInput.Visibility = isReader ? Visibility.Collapsed : Visibility.Visible;
            PasswordHint.Visibility = isReader ? Visibility.Collapsed : Visibility.Visible;
        }

        private void Next_Click(object sender, RoutedEventArgs e)
        {
            if (_step == 1) { _step = 2; ShowStep(); return; }
            if (_step == 2)
            {
                try
                {
                    var item = BuildResult();
                    var secretKey = "connection:" + item.Id + ":password";
                    var password = !String.IsNullOrWhiteSpace(PasswordInput.Password)
                        ? PasswordInput.Password : _store.GetSecret(secretKey);
                    var movementPassword = !String.IsNullOrWhiteSpace(MovementPasswordInput.Password)
                        ? MovementPasswordInput.Password : _store.GetSecret(ConnectionAgentRuntime.MovementPasswordKey(item));
                    var newAgentToken = PrepareAgentCredential(item);
                    Mouse.OverrideCursor = System.Windows.Input.Cursors.Wait;
                    var test = ConnectionTester.Test(item, password);
                    if (!test.Success) throw new InvalidOperationException(test.Summary);
                    if (item.Type == ConnectionTypes.Parking &&
                        (!String.IsNullOrWhiteSpace(Get(item, "movementServer1")) ||
                         !String.IsNullOrWhiteSpace(Get(item, "movementDatabase1")) ||
                         !String.IsNullOrWhiteSpace(Get(item, "movementServer2")) ||
                         !String.IsNullOrWhiteSpace(Get(item, "movementDatabase2"))))
                        ConnectionTester.TestParkingMovements(item, password, movementPassword, test);
                    item.Status = "本地检测通过，等待 PMS 上线";
                    item.StatusTone = "warning";
                    item.Summary = test.Summary;
                    if (!String.IsNullOrWhiteSpace(PasswordInput.Password)) _store.SetSecret(secretKey, PasswordInput.Password);
                    if (!String.IsNullOrWhiteSpace(MovementPasswordInput.Password))
                        _store.SetSecret(ConnectionAgentRuntime.MovementPasswordKey(item), MovementPasswordInput.Password);
                    if (newAgentToken != null) _store.SetSecret(ConnectionAgentRuntime.TokenKey(item), newAgentToken);
                    Result = item;
                    ResultChecksText.Text = String.Join("\n", test.Checks.Select(check => "✓  " + check).Concat(new[] { "✓  凭据已在本机加密保存" }).ToArray());
                }
                catch (Exception exception) { MessageBox.Show(exception.Message, "无法保存连接", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
                finally { Mouse.OverrideCursor = null; }
                _step = 3; ShowStep(); return;
            }
            DialogResult = true;
        }

        private void Back_Click(object sender, RoutedEventArgs e)
        {
            if (_step == 1) { DialogResult = false; return; }
            _step--; ShowStep();
        }

        private void ShowStep()
        {
            TypePanel.Visibility = _step == 1 ? Visibility.Visible : Visibility.Collapsed;
            ParameterPanel.Visibility = _step == 2 ? Visibility.Visible : Visibility.Collapsed;
            ResultPanel.Visibility = _step == 3 ? Visibility.Visible : Visibility.Collapsed;
            TitleText.Text = _step == 1 ? "要连接什么？" : _step == 2 ? "确认检测结果" : "测试并保存";
            BackButton.Content = _step == 1 ? "取消" : "上一步";
            NextButton.Content = _step == 1 ? "继续" : _step == 2 ? "测试连接" : "完成";
            SetStepCircle(StepOneCircle, _step >= 1); SetStepCircle(StepTwoCircle, _step >= 2); SetStepCircle(StepThreeCircle, _step >= 3);
            if (_step == 2) UpdateFieldVisibility();
        }

        private static void SetStepCircle(Border border, bool active)
        {
            border.Background = active ? new SolidColorBrush(Color.FromRgb(49, 85, 138)) : Brushes.Transparent;
            var text = border.Child as TextBlock;
            if (text != null) text.Foreground = active ? Brushes.White : new SolidColorBrush(Color.FromRgb(101, 119, 138));
        }

        private ConnectionConfiguration BuildResult()
        {
            if (String.IsNullOrWhiteSpace(NameInput.Text)) throw new InvalidOperationException("请填写连接名称");
            if ((_type == ConnectionTypes.Parking || _type == ConnectionTypes.LegacyAccess) && String.IsNullOrWhiteSpace(ServerInput.Text))
                throw new InvalidOperationException("未检测到 SQL Server，请填写服务器地址");
            var item = _editing ?? new ConnectionConfiguration();
            item.Type = _type;
            item.Name = NameInput.Text.Trim();
            item.HostName = _host.Name;
            item.HostIp = _host.IpAddress;
            item.Parameters["server"] = ServerInput.Text.Trim();
            item.Parameters["user"] = UserInput.Text.Trim();
            item.Parameters["database1"] = DatabaseOneInput.Text.Trim();
            item.Parameters["database2"] = DatabaseTwoInput.Text.Trim();
            item.Parameters["movementServer1"] = MovementServerOneInput.Text.Trim();
            item.Parameters["movementDatabase1"] = MovementDatabaseOneInput.Text.Trim();
            item.Parameters["movementServer2"] = MovementServerTwoInput.Text.Trim();
            item.Parameters["movementDatabase2"] = MovementDatabaseTwoInput.Text.Trim();
            item.Parameters["movementUser"] = MovementUserInput.Text.Trim();
            item.Parameters["mjSystemPath"] = MjSystemPathInput.Text.Trim();
            item.Parameters["icCardPath"] = IcCardPathInput.Text.Trim();
            item.DataLocation = _type == ConnectionTypes.CardReader ? "本机 USB 端口"
                : _type == ConnectionTypes.BuildingAccess ? "本机 MjSystem / iCCard MDB"
                : String.IsNullOrWhiteSpace(ServerInput.Text) ? "尚未配置" : "SQL Server " + ServerInput.Text.Trim();
            return item;
        }

        private string PrepareAgentCredential(ConnectionConfiguration item)
        {
            var input = AgentCredentialInput.Password;
            if (String.IsNullOrWhiteSpace(input))
            {
                string error;
                if (!ConnectionAgentRuntime.CanStart(item, _store, out error))
                    throw new InvalidOperationException(error + "，请从 PMS 注册页面重新生成并粘贴整段密钥");
                return null;
            }
            string agentId;
            string token;
            if (!Pms.AccessCardAgent.AgentConfig.TryParseConnectionKey(input, out agentId, out token))
                throw new InvalidOperationException("一次性连接密钥格式不正确，请完整复制，不要只复制代理 ID");
            var expected = ConnectionAgentRuntime.KindFor(item.Type);
            if (!agentId.StartsWith(expected + "-", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("一次性连接密钥属于 " + agentId.Split('-')[0] + "，与当前连接类型不匹配");
            item.Parameters["agentId"] = agentId;
            return token;
        }

        private static string Get(ConnectionConfiguration item, string key)
        {
            string value; return item.Parameters.TryGetValue(key, out value) ? value : "";
        }

    }
}
