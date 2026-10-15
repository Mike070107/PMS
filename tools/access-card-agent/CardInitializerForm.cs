using System;
using System.Drawing;
using System.IO;
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
        private readonly Label _message = new Label();
        private readonly Button _primary = new Button();
        private readonly Timer _timer = new Timer();
        private bool _running;
        private bool _busy;
        private bool _waitForRemoval;
        private int _completed;

        public CardInitializerForm(string root)
        {
            _profilePath = Path.Combine(root, CardProfiles.ProtectedFileName);
            Text = "枫桦景苑门禁卡加密初始化助手";
            Font = new Font("Microsoft YaHei UI", 10F);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(640, 620);
            ClientSize = new Size(720, 680);
            BackColor = Color.FromArgb(244, 250, 249);
            Icon = SystemIcons.Shield;

            var shell = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(32), ColumnCount = 1, RowCount = 6 };
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
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

            var progress = new Panel { Dock = DockStyle.Top, Height = 112, BackColor = Color.FromArgb(15, 118, 110), Margin = new Padding(0, 0, 0, 16), Padding = new Padding(22) };
            progress.Controls.Add(new Label { Text = "本次已完成", AutoSize = true, ForeColor = Color.White, Location = new Point(22, 18) });
            _count.Text = "0 张";
            _count.AutoSize = true;
            _count.Font = new Font(Font.FontFamily, 24F, FontStyle.Bold);
            _count.ForeColor = Color.White;
            _count.Location = new Point(18, 46);
            progress.Controls.Add(_count);
            shell.Controls.Add(progress);

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
            Task.Factory.StartNew(delegate
            {
                try
                {
                    var profiles = CardProfiles.Load(_profilePath);
                    var inspection = CardReader.Inspect(profiles);
                    if (_waitForRemoval) return new CardWorkResult { Inspection = inspection, WaitOnly = true };
                    var wrote = inspection.State == PropertyCardState.UnencryptedBlank;
                    if (wrote)
                        inspection = CardReader.InitializeBlank(profiles);
                    return new CardWorkResult { Inspection = inspection, Wrote = wrote };
                }
                catch (Exception exception) { return new CardWorkResult { Error = exception.Message }; }
            }).ContinueWith(task => BeginInvoke((Action)delegate
            {
                _busy = false;
                var result = task.Result;
                if (result.Error != null)
                {
                    if (_waitForRemoval && result.Error.IndexOf("放到 ACR122U", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        _waitForRemoval = false;
                        _cardState.Text = "等待下一张空白卡";
                        _message.Text = "请放入第 " + (_completed + 1) + " 张未加密空白卡。";
                    }
                    else if (!_waitForRemoval)
                    {
                        _cardState.Text = "未放卡";
                        _message.Text = result.Error;
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
                }
            }));
        }

        private sealed class CardWorkResult
        {
            public CardInspection Inspection { get; set; }
            public bool WaitOnly { get; set; }
            public bool Wrote { get; set; }
            public string Error { get; set; }
        }
    }
}
