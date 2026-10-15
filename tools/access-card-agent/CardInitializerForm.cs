using System;
using System.Drawing;
using System.IO;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Pms.AccessCardAgent
{
    /** 采购空白卡的离线批量加密工具；不连 PMS，不分配 ICNO，不写业主权限。 */
    internal sealed class CardInitializerForm : Form
    {
        private readonly string _profilePath;
        private readonly Label _readerState = new Label();
        private readonly Label _cardState = new Label();
        private readonly Label _count = new Label();
        private readonly Label _summary = new Label();
        private readonly Label _message = new Label();
        private readonly TextBox _readKey = new TextBox();
        private readonly TextBox _writeKey = new TextBox();
        private readonly ListView _log = new ListView();
        private readonly Button _primary = new Button();
        private readonly Timer _timer = new Timer();
        private bool _running;
        private bool _busy;
        private bool _waitForRemoval;
        private int _completed;
        private int _alreadyInitialized, _alreadyAuthorized, _rejected, _failed;
        private readonly HashSet<string> _seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly string _logPath;

        public CardInitializerForm(string root)
        {
            _profilePath = Path.Combine(root, CardProfiles.ProtectedFileName);
            _logPath = Path.Combine(root, "logs", "card-initializer-" + DateTime.Now.ToString("yyyyMMdd") + ".csv");
            Text = "枫桦景苑门禁卡加密初始化助手";
            Font = new Font("Microsoft YaHei UI", 10F);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(760, 720);
            ClientSize = new Size(900, 780);
            BackColor = Color.FromArgb(244, 250, 249);
            Icon = SystemIcons.Shield;

            var shell = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(28), ColumnCount = 1, RowCount = 8 };
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(shell);

            shell.Controls.Add(new Label {
                Text = "枫桦景苑门禁卡加密初始化",
                AutoSize = true, Font = new Font(Font.FontFamily, 20F, FontStyle.Bold),
                ForeColor = Color.FromArgb(19, 78, 74), Margin = new Padding(0, 0, 0, 8)
            });
            shell.Controls.Add(new Label {
                Text = "仅用于将采购的未加密空白卡制作成本小区初始卡。本工具不写房号、不授权大门、不连接捷顺数据库。",
                AutoSize = true, MaximumSize = new Size(640, 0), ForeColor = Color.FromArgb(71, 85, 105),
                Margin = new Padding(0, 0, 0, 24)
            });

            var states = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, BackColor = Color.White, Padding = new Padding(20), Margin = new Padding(0, 0, 0, 16) };
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            states.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            AddState(states, "USB 发卡器", _readerState);
            AddState(states, "当前卡片", _cardState);
            shell.Controls.Add(states);

            var keys = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, BackColor = Color.White, Padding = new Padding(16), Margin = new Padding(0, 0, 0, 16) };
            keys.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); keys.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            AddKey(keys, "默认读取密钥", _readKey, "FFFFFFFFFFFF");
            AddKey(keys, "目标写入密钥", _writeKey, "使用内置模板密钥");
            shell.Controls.Add(keys);

            var progress = new Panel { Dock = DockStyle.Top, Height = 112, BackColor = Color.FromArgb(15, 118, 110), Margin = new Padding(0, 0, 0, 16), Padding = new Padding(22) };
            progress.Controls.Add(new Label { Text = "本次已完成", AutoSize = true, ForeColor = Color.White, Location = new Point(22, 18) });
            _count.Text = "0 张";
            _count.AutoSize = true;
            _count.Font = new Font(Font.FontFamily, 24F, FontStyle.Bold);
            _count.ForeColor = Color.White;
            _count.Location = new Point(18, 46);
            progress.Controls.Add(_count);
            _summary.AutoSize = true; _summary.ForeColor = Color.White; _summary.Location = new Point(190, 58);
            progress.Controls.Add(_summary); UpdateSummary();
            shell.Controls.Add(progress);

            _log.Dock = DockStyle.Fill; _log.View = View.Details; _log.FullRowSelect = true; _log.GridLines = true;
            _log.Columns.Add("时间", 80); _log.Columns.Add("卡号 UID", 150); _log.Columns.Add("结果", 150); _log.Columns.Add("说明", 420);
            shell.Controls.Add(_log);

            _message.Dock = DockStyle.Fill;
            _message.Padding = new Padding(18);
            _message.BackColor = Color.White;
            _message.ForeColor = Color.FromArgb(51, 65, 85);
            _message.Text = "请连接 ACR122U，然后点击“开始批量初始化”。";
            _message.AutoEllipsis = true;
            shell.Controls.Add(_message);

            _primary.Text = "开始批量初始化";
            _primary.Height = 52;
            _primary.Dock = DockStyle.Bottom;
            _primary.FlatStyle = FlatStyle.Flat;
            _primary.FlatAppearance.BorderSize = 0;
            _primary.BackColor = Color.FromArgb(3, 105, 161);
            _primary.ForeColor = Color.White;
            _primary.Font = new Font(Font.FontFamily, 11F, FontStyle.Bold);
            _primary.Cursor = Cursors.Hand;
            _primary.Click += delegate { Toggle(); };
            shell.Controls.Add(_primary);

            _timer.Interval = 700;
            _timer.Tick += delegate { TickCards(); };
            _timer.Start();
            FormClosed += delegate { _timer.Stop(); _timer.Dispose(); };
            RefreshReader();
        }

        private static void AddKey(TableLayoutPanel panel, string caption, TextBox input, string placeholder)
        {
            var cell = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, RowCount = 2, Margin = new Padding(0, 0, 12, 0) };
            cell.Controls.Add(new Label { Text = caption, AutoSize = true, ForeColor = Color.FromArgb(71, 85, 105) });
            input.Text = caption.IndexOf("读取", StringComparison.Ordinal) >= 0 ? placeholder : "";
            input.PasswordChar = '●'; input.MaxLength = 12; input.Dock = DockStyle.Top;
            input.AccessibleDescription = placeholder;
            cell.Controls.Add(input); panel.Controls.Add(cell);
        }

        private static void AddState(TableLayoutPanel panel, string caption, Label value)
        {
            var cell = new Panel { Dock = DockStyle.Fill, Height = 72, Margin = new Padding(0, 0, 12, 0) };
            cell.Controls.Add(new Label { Text = caption, AutoSize = true, ForeColor = Color.FromArgb(100, 116, 139), Location = new Point(0, 2) });
            value.Text = "检测中…";
            value.AutoSize = true;
            value.Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold);
            value.ForeColor = Color.FromArgb(19, 78, 74);
            value.Location = new Point(0, 30);
            cell.Controls.Add(value);
            panel.Controls.Add(cell);
        }

        private void Toggle()
        {
            if (!_running && (!ValidKey(_readKey.Text) || (!String.IsNullOrWhiteSpace(_writeKey.Text) && !ValidKey(_writeKey.Text))))
            { _message.Text = "读取密钥和目标密钥必须是12位十六进制；目标密钥留空表示使用内置模板。"; return; }
            _running = !_running;
            _primary.Text = _running ? "停止批量初始化" : "开始批量初始化";
            _primary.BackColor = _running ? Color.FromArgb(71, 85, 105) : Color.FromArgb(3, 105, 161);
            _message.Text = _running ? "请放入第 1 张未加密空白卡。" : "已暂停，可继续本次批量。";
        }

        private void RefreshReader()
        {
            var ready = CardReader.HasAcr122();
            _readerState.Text = ready ? "ACR122U 已连接" : "未检测到 ACR122U";
            _readerState.ForeColor = ready ? Color.FromArgb(15, 118, 110) : Color.FromArgb(185, 28, 28);
        }

        private void TickCards()
        {
            RefreshReader();
            if (!_running || _busy || !CardReader.HasAcr122()) return;
            _busy = true;
            var readKey = _readKey.Text.Trim().ToUpperInvariant();
            var writeKey = _writeKey.Text.Trim().ToUpperInvariant();
            Task.Factory.StartNew(delegate
            {
                try
                {
                    var profiles = CardProfiles.Load(_profilePath);
                    var effective = String.IsNullOrWhiteSpace(writeKey) ? profiles : CardProfiles.WithUniformTargetKey(profiles, writeKey);
                    var inspection = CardReader.Inspect(effective, readKey);
                    if (_waitForRemoval) return new CardWorkResult { Inspection = inspection, WaitOnly = true };
                    var wrote = inspection.State == PropertyCardState.UnencryptedBlank;
                    if (wrote)
                        inspection = String.IsNullOrWhiteSpace(writeKey)
                            ? CardReader.InitializeBlank(profiles)
                            : CardReader.InitializeBlank(profiles, readKey, writeKey);
                    return new CardWorkResult { Inspection = inspection, Wrote = wrote };
                }
                catch (Exception exception) { return new CardWorkResult { Error = exception.Message }; }
            }).ContinueWith(task => BeginInvoke((Action)delegate
            {
                _busy = false;
                var result = task.Result;
                if (result.Error != null)
                {
                    var noCard = result.Error.IndexOf("放到 ACR122U", StringComparison.OrdinalIgnoreCase) >= 0;
                    if (_waitForRemoval && noCard)
                    {
                        _waitForRemoval = false;
                        _cardState.Text = "等待下一张空白卡";
                        _message.Text = "请放入第 " + (_completed + 1) + " 张未加密空白卡。";
                    }
                    else if (!_waitForRemoval && noCard)
                    {
                        _cardState.Text = "未放卡";
                        _message.Text = "请放入第 " + (_completed + 1) + " 张卡。";
                    }
                    else if (!_waitForRemoval)
                    {
                        _cardState.Text = "未放卡";
                        _message.Text = result.Error;
                        _failed++; AddLog("", "失败", result.Error); UpdateSummary();
                    }
                    return;
                }
                if (result.WaitOnly)
                {
                    _cardState.Text = "初始化完成，请取走";
                    return;
                }
                if (result.Inspection.State == PropertyCardState.Initialized && result.Wrote)
                {
                    _completed++;
                    _count.Text = _completed + " 张";
                    _cardState.Text = "本小区初始卡";
                    _message.Text = "第 " + _completed + " 张已加密并整卡回读通过，请取走卡片。";
                    _waitForRemoval = true;
                    AddLog(result.Inspection.Uid, "初始化成功", "整卡回读通过"); UpdateSummary();
                }
                else
                {
                    _cardState.Text = result.Inspection.Message;
                    _message.Text = result.Inspection.State == PropertyCardState.Initialized
                        ? "这张卡已经是本小区初始卡，本次未重复写入。请取走后放入空白卡。"
                        : result.Inspection.State == PropertyCardState.Authorized
                        ? "这是已发卡的有效卡，不会重新初始化。请取走后放入空白卡。"
                        : "这张卡不是可初始化的未加密空白卡，已停止写入。";
                    _waitForRemoval = true;
                    if (result.Inspection.State == PropertyCardState.Initialized) _alreadyInitialized++;
                    else if (result.Inspection.State == PropertyCardState.Authorized) _alreadyAuthorized++;
                    else _rejected++;
                    AddLog(result.Inspection.Uid, result.Inspection.State == PropertyCardState.Initialized ? "已初始化" : result.Inspection.State == PropertyCardState.Authorized ? "已授权" : "拒绝", result.Inspection.Message);
                    UpdateSummary();
                }
            }));
        }

        private static bool ValidKey(string value) { return Regex.IsMatch((value ?? "").Trim(), "^[0-9A-Fa-f]{12}$"); }

        private void UpdateSummary()
        {
            _summary.Text = "唯一UID " + _seen.Count + "  · 新完成 " + _completed + "  · 已初始化 " + _alreadyInitialized + "  · 已授权 " + _alreadyAuthorized + "  · 拒绝 " + _rejected + "  · 失败 " + _failed;
        }

        private void AddLog(string uid, string result, string detail)
        {
            uid = uid ?? "";
            if (!String.IsNullOrEmpty(uid) && !_seen.Add(uid)) detail += "（本次已处理过该UID）";
            var now = DateTime.Now;
            _log.Items.Insert(0, new ListViewItem(new[] { now.ToString("HH:mm:ss"), uid, result, detail }));
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
                if (!File.Exists(_logPath)) File.AppendAllText(_logPath, "time,uid,result,detail\r\n", new UTF8Encoding(true));
                File.AppendAllText(_logPath, Csv(now.ToString("yyyy-MM-dd HH:mm:ss")) + "," + Csv(uid) + "," + Csv(result) + "," + Csv(detail) + "\r\n", Encoding.UTF8);
            }
            catch (Exception exception) { _message.Text = "卡片处理已完成，但日志保存失败：" + exception.Message; }
        }

        private static string Csv(string value) { return "\"" + (value ?? "").Replace("\"", "\"\"") + "\""; }

        private sealed class CardWorkResult
        {
            public CardInspection Inspection { get; set; }
            public bool WaitOnly { get; set; }
            public bool Wrote { get; set; }
            public string Error { get; set; }
        }
    }
}
