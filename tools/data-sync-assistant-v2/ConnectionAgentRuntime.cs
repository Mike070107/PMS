using System;
using System.IO;
using System.Threading;
using Pms.AccessCardAgent;

namespace Pms.DataSyncAssistant
{
    internal sealed class ConnectionAgentSnapshot
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public bool Connected { get; set; }
        public string Message { get; set; }
        public string UpdatedAt { get; set; }
    }

    /** Runs one existing PMS agent protocol session for one configured connection. */
    internal sealed class ConnectionAgentRuntime : IDisposable
    {
        public static readonly string RuntimeVersion = typeof(ConnectionAgentRuntime).Assembly.GetName().Version.ToString(3);
        private readonly ConnectionConfiguration _connection;
        private readonly ConfigurationStore _store;
        private readonly HostConfiguration _host;
        private readonly ManualResetEvent _stop;
        private readonly object _stateLock = new object();
        private Thread _worker;
        private bool _connected;
        private string _message = "等待启动";
        private DateTimeOffset _updatedAt = DateTimeOffset.Now;

        public ConnectionAgentRuntime(ConnectionConfiguration connection, HostConfiguration host, ConfigurationStore store, ManualResetEvent stop)
        {
            _connection = connection;
            _host = host;
            _store = store;
            _stop = stop;
        }

        public void Start()
        {
            string error;
            if (!CanStart(_connection, _store, out error))
            {
                SetState(false, error);
                return;
            }
            _worker = new Thread(Run) { IsBackground = true, Name = "PMS-agent-" + _connection.Id };
            _worker.Start();
        }

        public void Stop(int milliseconds)
        {
            if (_worker != null) _worker.Join(milliseconds);
        }

        public ConnectionAgentSnapshot Snapshot()
        {
            lock (_stateLock)
            {
                return new ConnectionAgentSnapshot
                {
                    Id = _connection.Id,
                    Name = _connection.Name,
                    Connected = _connected,
                    Message = _message,
                    UpdatedAt = _updatedAt.ToString("o")
                };
            }
        }

        private void Run()
        {
            try
            {
                var config = BuildAgentConfig(_connection, _host);
                var token = _store.GetSecret(TokenKey(_connection));
                var api = new AgentApiClient(config, token, RuntimeVersion);
                var loop = new AgentLoop(config, api, delegate(string ignored)
                {
                    if (ignored == "parking-movement-db-password.dat")
                    {
                        var movementPassword = _store.GetSecret(MovementPasswordKey(_connection));
                        if (!String.IsNullOrWhiteSpace(movementPassword)) return movementPassword;
                    }
                    return _store.GetSecret(PasswordKey(_connection));
                }, SetState, delegate(AgentActivity activity)
                {
                    ActivityStore.Record(_store.RootPath, _connection.Id, _connection.Name, activity);
                });
                loop.Run(_stop);
            }
            catch (Exception exception)
            {
                SetState(false, exception.Message);
            }
        }

        internal static bool CanStart(ConnectionConfiguration connection, ConfigurationStore store, out string error)
        {
            var kind = KindFor(connection.Type);
            if (kind == null)
            {
                error = "不支持的连接类型";
                return false;
            }
            var agentId = Get(connection, "agentId");
            if (String.IsNullOrWhiteSpace(agentId))
            {
                error = "尚未填写 PMS 代理 ID";
                return false;
            }
            if (!agentId.StartsWith(kind + "-", StringComparison.OrdinalIgnoreCase))
            {
                error = "代理 ID 与连接类型不匹配";
                return false;
            }
            if (!store.HasSecret(TokenKey(connection)))
            {
                error = "尚未保存一次性连接密钥";
                return false;
            }
            error = null;
            return true;
        }

        internal static AgentConfig BuildAgentConfig(ConnectionConfiguration connection, HostConfiguration host)
        {
            var kind = KindFor(connection.Type);
            if (kind == null) throw new InvalidOperationException("不支持的连接类型");
            var config = AgentConfig.CreateDefaults(kind);
            config.BaseUrl = String.IsNullOrWhiteSpace(host.BaseUrl) ? "https://prsznh.cn/api/v1" : host.BaseUrl.TrimEnd('/');
            config.AgentId = Get(connection, "agentId");
            config.Name = connection.Name;
            config.PollIntervalMs = 2500;
            config.LegacySqlServer = Get(connection, "server");
            config.LegacyDatabase = Get(connection, "database1");
            config.LegacyUser = Get(connection, "user");
            config.ParkingSqlServer = Get(connection, "server");
            config.ParkingPhase1Database = Get(connection, "database1");
            config.ParkingPhase2Database = Get(connection, "database2");
            config.ParkingUser = Get(connection, "user");
            config.ParkingMovementPhase1Server = Get(connection, "movementServer1");
            config.ParkingMovementPhase1Database = Get(connection, "movementDatabase1");
            config.ParkingMovementPhase2Server = Get(connection, "movementServer2");
            config.ParkingMovementPhase2Database = Get(connection, "movementDatabase2");
            config.ParkingMovementUser = Get(connection, "movementUser");
            config.MjSystemDatabasePath = ResolveMdbPath(connection, "mjSystemPath", "MJDataBase.mdb");
            config.IcCardDatabasePath = ResolveMdbPath(connection, "icCardPath", "iCCard.mdb");
            return config;
        }

        internal static void TestPms(ConnectionConfiguration connection, HostConfiguration host, ConfigurationStore store)
        {
            string error;
            if (!CanStart(connection, store, out error)) throw new InvalidOperationException(connection.Name + "：" + error);
            var config = BuildAgentConfig(connection, host);
            var api = new AgentApiClient(config, store.GetSecret(TokenKey(connection)), RuntimeVersion);
            var hasReader = config.Kind != "issuer" || CardReader.HasAcr122();
            api.Heartbeat(AgentLoop.BuildCapabilities(config, hasReader, false));
        }

        internal static string KindFor(string type)
        {
            if (type == ConnectionTypes.Parking) return "parking_gateway";
            if (type == ConnectionTypes.LegacyAccess) return "legacy_sync";
            if (type == ConnectionTypes.BuildingAccess) return "access_gateway";
            if (type == ConnectionTypes.CardReader) return "issuer";
            return null;
        }

        internal static string TokenKey(ConnectionConfiguration connection)
        {
            return "connection:" + connection.Id + ":agentToken";
        }

        internal static string PasswordKey(ConnectionConfiguration connection)
        {
            return "connection:" + connection.Id + ":password";
        }

        internal static string MovementPasswordKey(ConnectionConfiguration connection)
        {
            return "connection:" + connection.Id + ":movementPassword";
        }

        private static string ResolveMdbPath(ConnectionConfiguration connection, string key, string fileName)
        {
            var exact = Get(connection, key);
            if (!String.IsNullOrWhiteSpace(exact)) return exact;
            var legacy = Get(connection, "path");
            if (Directory.Exists(legacy))
            {
                var matches = Directory.GetFiles(legacy, fileName, SearchOption.TopDirectoryOnly);
                if (matches.Length > 0) return matches[0];
            }
            return legacy;
        }

        private static string Get(ConnectionConfiguration connection, string key)
        {
            string value;
            return connection.Parameters != null && connection.Parameters.TryGetValue(key, out value) ? value : "";
        }

        private void SetState(bool connected, string message)
        {
            lock (_stateLock)
            {
                _connected = connected;
                _message = String.IsNullOrWhiteSpace(message) ? (connected ? "PMS 心跳正常" : "连接异常") : message;
                _updatedAt = DateTimeOffset.Now;
            }
        }

        public void Dispose()
        {
        }
    }
}
