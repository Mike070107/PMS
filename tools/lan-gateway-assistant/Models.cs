using System;
using System.Collections.Generic;
using System.ComponentModel;

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
        public bool Healthy { get; set; }
        public string Message { get; set; }
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
        internal RouteViewModel(GatewayRoute route) { _route = route; }
        public string Id { get { return _route.Id; } }
        public string Name { get { return _route.Name; } }
        public string PublicHostname { get { return _route.PublicHostname; } }
        public string LocalUrl { get { return _route.LocalUrl; } }
        public int RemotePort { get { return _route.RemotePort; } }
        public bool Enabled { get { return _route.Enabled; } }
        public string Status { get { return Enabled ? "本机已启用" : "已停用"; } }
        public string StatusBackground { get { return Enabled ? "#E6F4EF" : "#EDF1F5"; } }
        public string StatusForeground { get { return Enabled ? "#14765A" : "#617386"; } }
        internal GatewayRoute Model { get { return _route; } }
        public event PropertyChangedEventHandler PropertyChanged;
        public void Refresh() { if (PropertyChanged != null) PropertyChanged(this, new PropertyChangedEventArgs(String.Empty)); }
    }
}
