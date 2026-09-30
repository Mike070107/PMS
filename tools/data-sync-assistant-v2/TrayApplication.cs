using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.ServiceProcess;
using System.Web.Script.Serialization;
using Forms = System.Windows.Forms;

namespace Pms.DataSyncAssistant
{
    internal sealed class TrayApplication : IDisposable
    {
        private readonly Forms.NotifyIcon _icon;
        private readonly Forms.Timer _timer;

        public TrayApplication()
        {
            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add("打开 PMS 数据同步助手", null, delegate { OpenSettings(); });
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("刷新运行状态", null, delegate { Refresh(); });
            menu.Items.Add("退出状态图标", null, delegate { System.Windows.Application.Current.Shutdown(); });
            _icon = new Forms.NotifyIcon
            {
                Icon = Icon.ExtractAssociatedIcon(Process.GetCurrentProcess().MainModule.FileName) ?? SystemIcons.Application,
                Text = "PMS 数据同步助手",
                Visible = true,
                ContextMenuStrip = menu
            };
            _icon.DoubleClick += delegate { OpenSettings(); };
            _timer = new Forms.Timer { Interval = 15000 };
            _timer.Tick += delegate { Refresh(); };
            _timer.Start();
            Refresh();
        }

        private void Refresh()
        {
            var service = ServiceState();
            var detail = HealthState();
            var text = "PMS 数据同步助手：" + service;
            if (!String.IsNullOrWhiteSpace(detail)) text += "，" + detail;
            _icon.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        }

        private static string ServiceState()
        {
            try
            {
                using (var service = new ServiceController(UnifiedServiceManager.ServiceName))
                    return service.Status == ServiceControllerStatus.Running ? "服务运行中" : "服务" + service.Status;
            }
            catch { return "服务未安装"; }
        }

        private static string HealthState()
        {
            try
            {
                var path = Path.Combine(new ConfigurationStore().RootPath, "health.json");
                if (!File.Exists(path)) return "等待首次检测";
                var root = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)) as System.Collections.Generic.Dictionary<string, object>;
                var values = root == null || !root.ContainsKey("connections") ? null : root["connections"] as object[];
                if (values == null || values.Length == 0) return "没有启用的连接";
                var online = values.Count(value =>
                {
                    var item = value as System.Collections.Generic.Dictionary<string, object>;
                    return item != null && item.ContainsKey("pmsConnected") && Convert.ToBoolean(item["pmsConnected"]);
                });
                return online + "/" + values.Length + " 个连接在线";
            }
            catch { return "状态文件暂不可读"; }
        }

        private static void OpenSettings()
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Process.GetCurrentProcess().MainModule.FileName,
                UseShellExecute = true
            });
        }

        public void Dispose()
        {
            _timer.Stop();
            _timer.Dispose();
            _icon.Visible = false;
            _icon.Dispose();
        }
    }
}
