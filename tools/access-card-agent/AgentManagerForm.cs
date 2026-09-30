using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Pms.AccessCardAgent
{
    internal sealed class AgentManagerForm : Form
    {
        private readonly string _root;
        private readonly string _configPath;
        private readonly string _tokenPath;
        private readonly string _legacyPasswordPath;
        private readonly string _icCardPasswordPath;
        private readonly string _parkingPasswordPath;
        private readonly ComboBox _kind = new ComboBox();
        private readonly TextBox _name = new TextBox();
        private readonly TextBox _token = new TextBox();
        private readonly Label _databasePasswordLabel = new Label();
        private readonly TextBox _databasePassword = new TextBox();
        private readonly Label _parkingServerLabel;
        private readonly TextBox _parkingServer = new TextBox();
        private readonly Label _parkingPhase1Label;
        private readonly TextBox _parkingPhase1 = new TextBox();
        private readonly Label _parkingPhase2Label;
        private readonly TextBox _parkingPhase2 = new TextBox();
        private readonly Label _parkingUserLabel;
        private readonly TextBox _parkingUser = new TextBox();
        private readonly Label _status = new Label();
        private readonly Button _testButton = new Button();
        private readonly Button _installButton = new Button();
        private AgentConfig _existing;

        public AgentManagerForm(string root)
        {
            _root = root;
            _configPath = Path.Combine(root, "agent.config.json");
            _tokenPath = Path.Combine(root, "agent.token.dat");
            _legacyPasswordPath = Path.Combine(root, "legacy-db-password.dat");
            _icCardPasswordPath = Path.Combine(root, "iccard-db-password.dat");
            _parkingPasswordPath = Path.Combine(root, "parking-db-password.dat");

            Text = "PMS 数据同步助手";
            Font = new Font("Microsoft YaHei UI", 10F);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(600, 680);
            ClientSize = new Size(640, 720);
            Icon = SystemIcons.Application;

            var rootPanel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(22),
                ColumnCount = 1,
                RowCount = 5
            };
            rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            rootPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(rootPanel);

            rootPanel.Controls.Add(new Label
            {
                Text = "PMS 数据同步助手",
                AutoSize = true,
                Font = new Font(Font.FontFamily, 18F, FontStyle.Bold),
                Margin = new Padding(0, 0, 0, 8)
            });
            rootPanel.Controls.Add(new Label
            {
                Text = "选择这台电脑的用途，然后粘贴 PMS 网页生成的一次性连接密钥。代理 ID 会自动识别并固定保存。",
                AutoSize = true,
                MaximumSize = new Size(570, 0),
                ForeColor = Color.DimGray,
                Margin = new Padding(0, 0, 0, 12)
            });

            var fields = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Padding = new Padding(0, 4, 0, 10) };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            rootPanel.Controls.Add(fields);

            _kind.DropDownStyle = ComboBoxStyle.DropDownList;
            _kind.Items.Add(new KindItem("legacy_sync", "192.168.1.80 旧库同步"));
            _kind.Items.Add(new KindItem("access_gateway", "192.168.1.88 门禁网关"));
            _kind.Items.Add(new KindItem("parking_gateway", "停车系统网关（parking1 / parking2）"));
            _kind.Items.Add(new KindItem("issuer", "ACR122U 发卡电脑"));
            _kind.SelectedIndexChanged += delegate { ApplyKindDefaults(); };
            AddField(fields, "电脑用途", _kind);
            AddField(fields, "电脑名称", _name);
            _token.UseSystemPasswordChar = true;
            AddField(fields, "一次性连接密钥", _token);
            _parkingServerLabel = AddField(fields, "SQL Server", _parkingServer);
            _parkingPhase1Label = AddField(fields, "一期数据库", _parkingPhase1);
            _parkingPhase2Label = AddField(fields, "二期数据库", _parkingPhase2);
            _parkingUserLabel = AddField(fields, "数据库用户", _parkingUser);
            _databasePassword.AutoSize = true;
            _databasePasswordLabel.AutoSize = true;
            _databasePasswordLabel.Anchor = AnchorStyles.Left;
            _databasePassword.UseSystemPasswordChar = true;
            var passwordRow = fields.RowCount++;
            fields.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            fields.Controls.Add(_databasePasswordLabel, 0, passwordRow);
            fields.Controls.Add(_databasePassword, 1, passwordRow);
            _databasePassword.Dock = DockStyle.Fill;
            _databasePassword.Margin = new Padding(0, 3, 0, 3);

            _status.AutoSize = true;
            _status.Padding = new Padding(10);
            _status.BackColor = Color.FromArgb(245, 247, 250);
            _status.ForeColor = Color.FromArgb(55, 65, 81);
            _status.Dock = DockStyle.Fill;
            rootPanel.Controls.Add(_status);

            var buttons = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = false, Height = 54, ColumnCount = 4, RowCount = 1, Margin = new Padding(0, 10, 0, 0) };
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 22));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 24));
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
            buttons.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            _installButton.Text = "保存并安装后台服务";
            _installButton.Dock = DockStyle.Fill;
            _installButton.Height = 46;
            _installButton.Click += delegate { SaveAndInstall(); };
            _testButton.Text = "保存并测试连接";
            _testButton.Dock = DockStyle.Fill;
            _testButton.Height = 46;
            _testButton.Click += delegate { SaveAndTest(); };
            var openWeb = new Button { Text = "打开 PMS 注册页面", Dock = DockStyle.Fill, Height = 46 };
            openWeb.Click += delegate { Process.Start(new ProcessStartInfo { FileName = "https://prsznh.cn/access-cards", UseShellExecute = true }); };
            var updateButton = new Button { Text = "安装更新", Dock = DockStyle.Fill, Height = 46 };
            updateButton.Click += delegate { InstallUpdate(); };
            buttons.Controls.Add(openWeb, 0, 0);
            buttons.Controls.Add(updateButton, 1, 0);
            buttons.Controls.Add(_testButton, 2, 0);
            buttons.Controls.Add(_installButton, 3, 0);
            rootPanel.Controls.Add(buttons);

            LoadExisting();
        }

        private static Label AddField(TableLayoutPanel panel, string label, Control control)
        {
            var row = panel.RowCount++;
            panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            var labelControl = new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 10, 4) };
            panel.Controls.Add(labelControl, 0, row);
            control.Dock = DockStyle.Fill;
            control.Margin = new Padding(0, 3, 0, 3);
            panel.Controls.Add(control, 1, row);
            return labelControl;
        }

        private void LoadExisting()
        {
            try { if (File.Exists(_configPath)) _existing = AgentConfig.Load(_configPath); }
            catch (Exception exception) { SetStatus("现有配置无法读取：" + exception.Message, true); }
            var selectedKind = _existing == null ? "legacy_sync" : _existing.Kind;
            for (var i = 0; i < _kind.Items.Count; i++)
                if (((KindItem)_kind.Items[i]).Value == selectedKind) _kind.SelectedIndex = i;
            if (_existing != null)
            {
                // 一个安装目录只属于一个后台服务。禁止在原目录切换用途，避免另一服务的
                // agent.config.json / DPAPI 密钥被覆盖。
                _kind.Enabled = false;
                _name.Text = _existing.Name;
                _parkingServer.Text = _existing.ParkingSqlServer;
                _parkingPhase1.Text = _existing.ParkingPhase1Database;
                _parkingPhase2.Text = _existing.ParkingPhase2Database;
                _parkingUser.Text = _existing.ParkingUser;
            }
            _token.PlaceholderTextCompat(File.Exists(_tokenPath) ? "已保存，留空保持不变" : "请粘贴一次性密钥");
            SetStatus(File.Exists(_tokenPath) ? "已找到本机密钥，可直接测试或安装后台服务。" : "请完成配置。", false);
        }

        private void InstallUpdate()
        {
            using (var dialog = new OpenFileDialog())
            {
                dialog.Title = "选择新版 PMS 数据同步助手";
                dialog.Filter = "PMS 数据同步助手 (Pms.DataSyncAssistant.exe)|Pms.DataSyncAssistant.exe";
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                var current = Process.GetCurrentProcess().MainModule.FileName;
                if (String.Equals(Path.GetFullPath(dialog.FileName), Path.GetFullPath(current), StringComparison.OrdinalIgnoreCase))
                {
                    SetStatus("请选择解压到其他位置的新版程序。", true);
                    return;
                }
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = dialog.FileName,
                        Arguments = "--apply-update \"" + current + "\" " + Process.GetCurrentProcess().Id,
                        UseShellExecute = true,
                        Verb = "runas"
                    });
                    Close();
                }
                catch (Exception exception) { SetStatus("更新未开始：" + exception.Message, true); }
            }
        }

        private void ApplyKindDefaults()
        {
            var item = _kind.SelectedItem as KindItem;
            if (item == null) return;
            if (_existing == null || _existing.Kind != item.Value) _name.Text = AgentConfig.CreateDefaults(item.Value).Name;
            var needsPassword = item.Value != "issuer";
            var isParking = item.Value == "parking_gateway";
            _parkingServerLabel.Visible = _parkingServer.Visible = isParking;
            _parkingPhase1Label.Visible = _parkingPhase1.Visible = isParking;
            _parkingPhase2Label.Visible = _parkingPhase2.Visible = isParking;
            _parkingUserLabel.Visible = _parkingUser.Visible = isParking;
            if (isParking)
            {
                var defaults = AgentConfig.CreateDefaults(item.Value);
                if (String.IsNullOrWhiteSpace(_parkingServer.Text)) _parkingServer.Text = defaults.ParkingSqlServer;
                if (String.IsNullOrWhiteSpace(_parkingPhase1.Text)) _parkingPhase1.Text = defaults.ParkingPhase1Database;
                if (String.IsNullOrWhiteSpace(_parkingPhase2.Text)) _parkingPhase2.Text = defaults.ParkingPhase2Database;
            }
            _databasePasswordLabel.Visible = needsPassword;
            _databasePassword.Visible = needsPassword;
            _databasePasswordLabel.Text = item.Value == "legacy_sync" ? ".80 旧库密码"
                : item.Value == "access_gateway" ? ".88 iCCard 密码" : "停车数据库密码";
            _databasePassword.PlaceholderTextCompat("已保存可留空");
        }

        private AgentConfig SaveSettings()
        {
            var item = _kind.SelectedItem as KindItem;
            if (item == null) throw new InvalidOperationException("请选择电脑用途");
            var config = _existing != null && _existing.Kind == item.Value ? _existing : AgentConfig.CreateDefaults(item.Value);
            config.Kind = item.Value;
            config.Name = _name.Text.Trim();
            var savedToken = "";
            if (!String.IsNullOrWhiteSpace(_token.Text))
            {
                string parsedAgentId;
                if (AgentConfig.TryParseConnectionKey(_token.Text, out parsedAgentId, out savedToken))
                {
                    if (!parsedAgentId.StartsWith(item.Value + "-", StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("连接密钥与所选服务类型不匹配");
                    config.AgentId = parsedAgentId;
                }
                else if (_existing != null && _existing.Kind == item.Value)
                {
                    // 兼容旧版网页单独生成的原始 token。
                    savedToken = _token.Text.Trim();
                }
                else throw new InvalidOperationException("请粘贴 PMS 网页生成的完整连接密钥");
            }
            if (item.Value == "parking_gateway")
            {
                config.ParkingSqlServer = _parkingServer.Text.Trim();
                config.ParkingPhase1Database = _parkingPhase1.Text.Trim();
                config.ParkingPhase2Database = _parkingPhase2.Text.Trim();
                config.ParkingUser = _parkingUser.Text.Trim();
            }
            AgentConfig.Save(_configPath, config);
            if (!String.IsNullOrWhiteSpace(savedToken)) SecretStore.Save(_tokenPath, savedToken);
            if (!File.Exists(_tokenPath)) throw new InvalidOperationException("请粘贴一次性连接密钥");
            if (!String.IsNullOrWhiteSpace(_databasePassword.Text))
                SecretStore.Save(item.Value == "legacy_sync" ? _legacyPasswordPath
                    : item.Value == "access_gateway" ? _icCardPasswordPath : _parkingPasswordPath, _databasePassword.Text);
            var requiredPasswordPath = item.Value == "legacy_sync" ? _legacyPasswordPath
                : item.Value == "access_gateway" ? _icCardPasswordPath
                : item.Value == "parking_gateway" ? _parkingPasswordPath : null;
            if (requiredPasswordPath != null && !File.Exists(requiredPasswordPath))
                throw new InvalidOperationException(item.Value == "legacy_sync"
                    ? "请输入 .80 旧发卡数据库密码"
                    : item.Value == "access_gateway" ? "请输入 .88 iCCard Access 数据库密码"
                    : "请输入停车 SQL Server 数据库密码");
            _existing = config;
            _token.Clear();
            _databasePassword.Clear();
            return config;
        }

        private void SaveAndTest()
        {
            AgentConfig config;
            try { config = SaveSettings(); }
            catch (Exception exception) { SetStatus(exception.Message, true); return; }
            SetBusy(true);
            SetStatus("正在连接 PMS…", false);
            Task.Factory.StartNew(delegate { return TestConnections(config); }).ContinueWith(task => BeginInvoke((Action)delegate
            {
                SetBusy(false);
                SetStatus(task.IsFaulted ? FriendlyError(task.Exception) : task.Result, task.IsFaulted);
            }));
        }

        private void SaveAndInstall()
        {
            AgentConfig config;
            try { config = SaveSettings(); }
            catch (Exception exception) { SetStatus(exception.Message, true); return; }
            SetBusy(true);
            SetStatus("正在测试 PMS 连接…", false);
            Task.Factory.StartNew(delegate { return TestConnections(config); }).ContinueWith(task => BeginInvoke((Action)delegate
            {
                if (task.IsFaulted)
                {
                    SetBusy(false);
                    SetStatus(FriendlyError(task.Exception), true);
                    return;
                }
                InstallServiceWithElevation();
            }));
        }

        private string TestConnections(AgentConfig config)
        {
            new AgentApiClient(config, SecretStore.Load(_tokenPath)).Heartbeat(
                AgentLoop.BuildCapabilities(config, config.Kind != "issuer" || CardReader.HasAcr122()));
            AgentStatus.MarkConnected();
            if (config.Kind != "parking_gateway")
                return "连接成功，PMS 已接受这台电脑的心跳。";
            var probes = ParkingDatabase.ProbeBoth(config, SecretStore.Load(_parkingPasswordPath));
            return "连接成功：PMS 心跳正常，" + probes[0].Database + " 和 " + probes[1].Database + " 均可只读访问。";
        }

        private void InstallServiceWithElevation()
        {
            try
            {
                SetStatus("连接成功，正在请求 Windows 管理员授权…", false);
                var process = Process.Start(new ProcessStartInfo
                {
                    FileName = Process.GetCurrentProcess().MainModule.FileName,
                    Arguments = "--install-service",
                    Verb = "runas",
                    UseShellExecute = true
                });
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException("后台服务安装失败，请允许 Windows 管理员授权。");
                SetStatus("安装完成。后台服务已启动，右下角状态图标会自动出现。", false);
            }
            catch (Exception exception) { SetStatus(exception.Message, true); }
            finally { SetBusy(false); }
        }

        private void SetBusy(bool busy)
        {
            _testButton.Enabled = !busy;
            _installButton.Enabled = !busy;
        }

        private void SetStatus(string message, bool error)
        {
            _status.Text = message;
            _status.ForeColor = error ? Color.FromArgb(185, 28, 28) : Color.FromArgb(22, 101, 52);
        }

        private static string FriendlyError(AggregateException aggregate)
        {
            var exception = aggregate.Flatten().InnerExceptions[0];
            return "连接失败：" + exception.Message;
        }

        private sealed class KindItem
        {
            public readonly string Value;
            private readonly string _label;
            public KindItem(string value, string label) { Value = value; _label = label; }
            public override string ToString() { return _label; }
        }
    }

    internal static class TextBoxCompatibility
    {
        // .NET 4 WinForms has no PlaceholderText property. Keep this extension as
        // an intentional no-op so the same form remains compatible with old hosts.
        public static void PlaceholderTextCompat(this TextBox textBox, string value) { }
    }
}
