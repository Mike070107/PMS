using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace Pms.DataSyncAssistant
{
    public sealed class AssistantConfiguration
    {
        public int SchemaVersion { get; set; }
        public HostConfiguration Host { get; set; }
        public List<ConnectionConfiguration> Connections { get; set; }

        public AssistantConfiguration()
        {
            SchemaVersion = 2;
            Host = new HostConfiguration();
            Connections = new List<ConnectionConfiguration>();
        }
    }

    public sealed class HostConfiguration
    {
        public string HostId { get; set; }
        public string Name { get; set; }
        public string IpAddress { get; set; }
        public string BaseUrl { get; set; }
        public bool Paired { get; set; }

        public HostConfiguration()
        {
            HostId = Guid.NewGuid().ToString("N");
            Name = Environment.MachineName;
            IpAddress = NetworkIdentity.GetPreferredIpv4();
            BaseUrl = "https://prsznh.cn/api/v1";
        }
    }

    public sealed class ConnectionConfiguration
    {
        public string Id { get; set; }
        public string Type { get; set; }
        public string Name { get; set; }
        public bool Enabled { get; set; }
        public string HostName { get; set; }
        public string HostIp { get; set; }
        public string DataLocation { get; set; }
        public string Status { get; set; }
        public string StatusTone { get; set; }
        public string Summary { get; set; }
        public Dictionary<string, string> Parameters { get; set; }

        public ConnectionConfiguration()
        {
            Id = Guid.NewGuid().ToString("N");
            Enabled = true;
            Status = "尚未测试";
            StatusTone = "neutral";
            Parameters = new Dictionary<string, string>();
        }
    }

    public sealed class ConnectionViewModel : INotifyPropertyChanged
    {
        private readonly ConnectionConfiguration _model;
        public ConnectionViewModel(ConnectionConfiguration model) { _model = model; }
        public ConnectionConfiguration Model { get { return _model; } }
        public string Id { get { return _model.Id; } }
        public string Name { get { return _model.Name; } }
        public string TypeLabel { get { return ConnectionTypes.Label(_model.Type); } }
        public string HostDisplay { get { return _model.HostName + " · " + _model.HostIp; } }
        public string DataLocation { get { return _model.DataLocation; } }
        public string Status { get { return _model.Status; } }
        public string StatusBackground
        {
            get
            {
                if (_model.StatusTone == "ok") return "#E8F6EF";
                if (_model.StatusTone == "error") return "#FCEBEC";
                if (_model.StatusTone == "working") return "#EAF0F9";
                if (_model.StatusTone == "warning") return "#FFF4D6";
                return "#EEF1F4";
            }
        }
        public string StatusForeground
        {
            get
            {
                if (_model.StatusTone == "ok") return "#24775F";
                if (_model.StatusTone == "error") return "#A43C45";
                if (_model.StatusTone == "working") return "#31558A";
                if (_model.StatusTone == "warning") return "#8A6418";
                return "#65778A";
            }
        }
        public string Summary { get { return _model.Summary; } }
        public bool IsHealthy { get { return _model.StatusTone == "ok"; } }
        public bool IsWarning { get { return _model.StatusTone == "warning"; } }
        public event PropertyChangedEventHandler PropertyChanged;
        public void Refresh() { if (PropertyChanged != null) PropertyChanged(this, new PropertyChangedEventArgs(null)); }
    }

    public static class ConnectionTypes
    {
        public const string Parking = "parking_sql";
        public const string LegacyAccess = "legacy_access_sql";
        public const string BuildingAccess = "building_access_mdb";
        public const string CardReader = "pcsc_reader";

        public static string Label(string type)
        {
            if (type == Parking) return "停车系统";
            if (type == LegacyAccess) return "小区大门门禁系统";
            if (type == BuildingAccess) return "楼栋门禁系统";
            if (type == CardReader) return "USB 发卡器";
            return "数据连接";
        }
    }

    internal static class NetworkIdentity
    {
        public static string GetPreferredIpv4()
        {
            try
            {
                foreach (var address in System.Net.Dns.GetHostAddresses(Environment.MachineName))
                    if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !System.Net.IPAddress.IsLoopback(address))
                        return address.ToString();
            }
            catch { }
            return "未检测到";
        }
    }
}
