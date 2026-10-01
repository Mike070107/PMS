using System;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewayConfigurationStore
    {
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        public string RootPath { get; private set; }
        public string ConfigPath { get { return Path.Combine(RootPath, "gateway.json"); } }
        public string TokenPath { get { return Path.Combine(RootPath, "gateway-token.dat"); } }
        public string RuntimeTokenPath { get { return Path.Combine(RootPath, "frp-token.runtime"); } }
        public string FrpcPath { get { return Path.Combine(RootPath, "bin", "frpc.exe"); } }
        public string InstalledExecutablePath { get { return Path.Combine(RootPath, "bin", "Pms.LanGatewayAssistant.exe"); } }
        public string FrpcConfigPath { get { return Path.Combine(RootPath, "frpc.toml"); } }
        public string LogPath { get { return Path.Combine(RootPath, "logs", "frpc.log"); } }
        public string HealthPath { get { return Path.Combine(RootPath, "health.json"); } }

        public GatewayConfigurationStore() : this(null, true) { }
        internal GatewayConfigurationStore(string rootPath, bool migrate)
        {
            RootPath = String.IsNullOrWhiteSpace(rootPath)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PMS", "LanGatewayAssistant")
                : rootPath;
            Directory.CreateDirectory(RootPath); Directory.CreateDirectory(Path.Combine(RootPath, "bin")); Directory.CreateDirectory(Path.Combine(RootPath, "logs"));
            if (migrate) { TryMigrateLegacy(); TryImportBootstrapFiles(); }
        }

        public GatewayConfiguration Load()
        {
            GatewayConfiguration value = null;
            try { if (File.Exists(ConfigPath)) value = _json.Deserialize<GatewayConfiguration>(File.ReadAllText(ConfigPath)); } catch { }
            if (value == null) value = new GatewayConfiguration();
            if (String.IsNullOrWhiteSpace(value.ComputerName)) value.ComputerName = Environment.MachineName;
            if (String.IsNullOrWhiteSpace(value.ServerAddress)) value.ServerAddress = "gateway.prsznh.cn";
            if (value.ServerPort <= 0) value.ServerPort = 443;
            if (value.Routes == null) value.Routes = new System.Collections.Generic.List<GatewayRoute>();
            return value;
        }

        public void Save(GatewayConfiguration value)
        {
            var content = _json.Serialize(value); var temporary = ConfigPath + ".new";
            File.WriteAllText(temporary, content, new UTF8Encoding(false));
            if (File.Exists(ConfigPath)) File.Replace(temporary, ConfigPath, ConfigPath + ".previous", true); else File.Move(temporary, ConfigPath);
        }

        public bool HasToken { get { return File.Exists(TokenPath) && new FileInfo(TokenPath).Length > 0; } }
        public void SaveToken(string token)
        {
            if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("代理连接密钥不能为空");
            var protectedValue = ProtectedData.Protect(Encoding.UTF8.GetBytes(token.Trim()), null, DataProtectionScope.LocalMachine);
            File.WriteAllBytes(TokenPath, protectedValue); RestrictFile(TokenPath);
        }
        public string ReadToken()
        {
            if (!HasToken) throw new InvalidOperationException("本机还没有导入代理连接凭据");
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(TokenPath), null, DataProtectionScope.LocalMachine));
        }
        public void WriteRuntimeToken()
        {
            File.WriteAllText(RuntimeTokenPath, ReadToken(), Encoding.ASCII);
            RestrictFile(RuntimeTokenPath);
        }

        public void InstallFrpc(string source)
        {
            if (!File.Exists(source)) throw new FileNotFoundException("代理核心 frpc.exe 不存在", source);
            Directory.CreateDirectory(Path.GetDirectoryName(FrpcPath)); File.Copy(source, FrpcPath, true); RestrictFile(FrpcPath);
        }

        private void TryMigrateLegacy()
        {
            if (File.Exists(ConfigPath) && HasToken && File.Exists(FrpcPath)) return;
            var legacy = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PMSGateway");
            if (!Directory.Exists(legacy)) return;
            var token = Path.Combine(legacy, "frp-token"); var executable = Path.Combine(legacy, "frpc.exe");
            if (!HasToken && File.Exists(token)) SaveToken(File.ReadAllText(token).Trim());
            if (!File.Exists(FrpcPath) && File.Exists(executable)) InstallFrpc(executable);
            if (!File.Exists(ConfigPath))
            {
                var value = Load(); value.Routes.Add(new GatewayRoute { Id = Guid.NewGuid().ToString("N"), Name = "用友财务系统", PublicHostname = "caiwu.prsznh.cn", LocalUrl = "http://192.168.110.251:8050", RemotePort = 18050, Enabled = true }); Save(value);
            }
        }

        private void TryImportBootstrapFiles()
        {
            var executableDirectory = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            var token = Path.Combine(executableDirectory, "frp-token");
            var frpc = Path.Combine(executableDirectory, "frpc.exe");
            if (!HasToken && File.Exists(token)) SaveToken(File.ReadAllText(token).Trim());
            if (!File.Exists(FrpcPath) && File.Exists(frpc)) InstallFrpc(frpc);
        }

        private static void RestrictFile(string path)
        {
            try
            {
                var security = new FileSecurity(); security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, AccessControlType.Allow));
                File.SetAccessControl(path, security);
            }
            catch { }
        }
    }
}
