using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Windows;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewayConfiguration
    {
        public string ApiBaseUrl { get; set; }
        public string DeviceId { get; set; }
        public string ComputerName { get; set; }
        public string ServerAddress { get; set; }
        public int ServerPort { get; set; }
        public List<GatewayRoute> Routes { get; set; }
        public int AppliedRevision { get; set; }
        /** PMS 网页删除了这台客户端（或在别处重新配对）后留下的说明，重新配对时清掉。 */
        public string RemovedNotice { get; set; }
    }

    internal sealed class GatewayRoute
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string PublicHostname { get; set; }
        public string LocalUrl { get; set; }
        public int RemotePort { get; set; }
        public bool Enabled { get; set; }
        public int AppId { get; set; }
    }

    internal sealed class GatewayEnrollmentResponse
    {
        public string DeviceId { get; set; }
        public string DeviceToken { get; set; }
        public string FrpToken { get; set; }
        public string ApiBaseUrl { get; set; }
    }

    internal sealed class GatewayConfigurationEnvelope
    {
        public string Configuration { get; set; }
        public string Signature { get; set; }
    }

    internal sealed class ManagedGatewayConfiguration
    {
        public string DeviceId { get; set; }
        public int Revision { get; set; }
        public string ExpiresAt { get; set; }
        public string ServerAddress { get; set; }
        public int ServerPort { get; set; }
        public List<ManagedGatewayRoute> Routes { get; set; }
    }

    internal sealed class ManagedGatewayRoute
    {
        public int AppId { get; set; }
        public string Id { get; set; }
        public string Name { get; set; }
        public string PublicHostname { get; set; }
        public string LocalUrl { get; set; }
        public int RemotePort { get; set; }
        public bool Enabled { get; set; }
    }

    internal sealed class GatewayRouteReport
    {
        public int AppId { get; set; }
        /** 本机侧的稳定键。心跳线上只发 appId，这个字段不上网。 */
        public string Id { get; set; }
        public bool Healthy { get; set; }
        public string Message { get; set; }
    }

    internal sealed class GatewayHealthMinute
    {
        public string Minute { get; set; }
        public int Checks { get; set; }
        public int Failures { get; set; }
    }

    internal sealed class GatewayRouteHealth
    {
        public int AppId { get; set; }
        public string Id { get; set; }
        public string Name { get; set; }
        public bool Enabled { get; set; }
        public bool Healthy { get; set; }
        public string Message { get; set; }
        public string CheckedAt { get; set; }
        public string SinceAt { get; set; }
        public int ConsecutiveFailures { get; set; }
        public string LastFailureAt { get; set; }
        public string LastFailureMessage { get; set; }
        public List<GatewayHealthMinute> Minutes { get; set; }
    }

    internal sealed class GatewayStability
    {
        public string CheckedAt { get; set; }
        public int TunnelRestarts { get; set; }
        public string LastRestartAt { get; set; }
        public List<GatewayRouteHealth> Routes { get; set; }
    }

    internal sealed class GatewayHealth
    {
        public string CheckedAt { get; set; }
        public bool ProcessRunning { get; set; }
        public string Message { get; set; }
        public int ProcessId { get; set; }
        public int AppliedRevision { get; set; }
    }

    public sealed class RouteViewModel : INotifyPropertyChanged
    {
        private readonly GatewayRoute _route;
        private GatewayRouteHealth _health;
        private string _testMessage;
        private DateTimeOffset _testExpiresAt;
        internal RouteViewModel(GatewayRoute route, GatewayRouteHealth health) { _route = route; _health = health; }
        public string Id { get { return _route.Id; } }
        public string Name { get { return _route.Name; } }
        public string PublicHostname { get { return _route.PublicHostname; } }
        public string LocalUrl { get { return _route.LocalUrl; } }
        public int RemotePort { get { return _route.RemotePort; } }
        public bool Enabled { get { return _route.Enabled; } }
        private bool Measured { get { return _health != null && !String.IsNullOrEmpty(_health.CheckedAt); } }
        internal bool Failing { get { return Enabled && Measured && !_health.Healthy; } }
        internal bool Working { get { return Enabled && Measured && _health.Healthy; } }
        /** 手动点的测试结果先占住详情位，过一会儿自动让回给后台服务的实时结论。 */
        private string Testing { get { return _testMessage != null && DateTimeOffset.Now < _testExpiresAt ? _testMessage : null; } }

        public string Status
        {
            get
            {
                if (!Enabled) return "已停用";
                if (Testing != null) return "测试中";
                if (!Measured) return "等待检测";
                return _health.Healthy ? "正常" : "连不上";
            }
        }
        public string StatusBackground
        {
            get
            {
                if (!Enabled) return "#EDF1F5";
                if (Failing) return "#FBECEC";
                if (!Measured || Testing != null) return "#FDF4E3";
                return "#E6F4EF";
            }
        }
        public string StatusForeground
        {
            get
            {
                if (!Enabled) return "#617386";
                if (Failing) return "#A53A42";
                if (!Measured || Testing != null) return "#8A6316";
                return "#14765A";
            }
        }
        /** 这张卡此刻到底通不通，用一句话说完，不让人去翻日志。 */
        public string Detail
        {
            get
            {
                var testing = Testing;
                if (testing != null) return testing;
                if (!Enabled) return "PMS 已停用这个应用，本机不会转发它";
                if (!Measured) return "后台服务还没完成第一次检测";
                return _health.Message;
            }
        }
        public string DetailForeground { get { return Failing && Testing == null ? "#A53A42" : "#506A82"; } }
        public string AvailabilitySummary
        {
            get
            {
                if (!Enabled) return "已停用，不统计可用率";
                var value = GatewayStabilityLog.Availability(_health, DateTimeOffset.Now, GatewayStabilityLog.AvailabilityWindow);
                if (value == null) return "最近 1 小时还没有检测记录";
                return "最近 1 小时可用率 " + Percentage(value.Value) + Streak();
            }
        }
        public string FailureSummary
        {
            get
            {
                if (_health == null || String.IsNullOrEmpty(_health.LastFailureAt)) return "";
                DateTimeOffset at;
                if (!DateTimeOffset.TryParse(_health.LastFailureAt, out at)) return "";
                return "上次中断 " + at.ToString("MM-dd HH:mm") + " · " + _health.LastFailureMessage;
            }
        }
        /** 现在就是坏的时候不重复刷一遍，Detail 已经在说同一件事。 */
        public Visibility FailureVisibility { get { return !Failing && FailureSummary.Length > 0 ? Visibility.Visible : Visibility.Collapsed; } }
        internal GatewayRoute Model { get { return _route; } }
        internal void Apply(GatewayRouteHealth health) { _health = health; Refresh(); }
        internal void BeginTest() { _testMessage = "正在从本机访问内网地址…"; _testExpiresAt = DateTimeOffset.Now.AddMinutes(2); Refresh(); }
        internal void EndTest(string message) { _testMessage = message; _testExpiresAt = DateTimeOffset.Now.AddSeconds(20); Refresh(); }
        public event PropertyChangedEventHandler PropertyChanged;
        public void Refresh() { if (PropertyChanged != null) PropertyChanged(this, new PropertyChangedEventArgs(String.Empty)); }

        private string Streak()
        {
            if (Failing) return " · 已连续失败 " + _health.ConsecutiveFailures + " 次";
            if (!Measured || String.IsNullOrEmpty(_health.SinceAt)) return "";
            DateTimeOffset since;
            if (!DateTimeOffset.TryParse(_health.SinceAt, out since)) return "";
            return " · 已连续正常 " + Elapsed(DateTimeOffset.Now.Subtract(since));
        }

        internal static string Percentage(double value)
        {
            if (value >= 1) return "100%";
            return (value * 100).ToString("0.0") + "%";
        }

        internal static string Elapsed(TimeSpan value)
        {
            if (value.TotalMinutes < 1) return "不到 1 分钟";
            if (value.TotalHours < 1) return ((int)value.TotalMinutes) + " 分钟";
            if (value.TotalDays < 1) return ((int)value.TotalHours) + " 小时 " + value.Minutes + " 分钟";
            return ((int)value.TotalDays) + " 天 " + value.Hours + " 小时";
        }
    }
}
