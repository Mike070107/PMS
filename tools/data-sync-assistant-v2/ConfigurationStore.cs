using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Pms.DataSyncAssistant
{
    public sealed class ConfigurationStore
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PMS.DataSyncAssistant.V2");
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly string _root;
        private readonly string _configurationPath;
        private readonly string _secretsPath;
        public bool HasAnySecrets { get { return File.Exists(_secretsPath) && new FileInfo(_secretsPath).Length > 0; } }

        public ConfigurationStore() : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "PMS", "DataSyncAssistant")) { }

        internal ConfigurationStore(string root)
        {
            _root = root;
            _configurationPath = Path.Combine(root, "connections.json");
            _secretsPath = Path.Combine(root, "secrets.dat");
        }

        public string RootPath { get { return _root; } }

        public AssistantConfiguration Load()
        {
            Directory.CreateDirectory(_root);
            if (!File.Exists(_configurationPath))
            {
                var created = new AssistantConfiguration();
                Save(created);
                return created;
            }
            var value = _json.Deserialize<AssistantConfiguration>(File.ReadAllText(_configurationPath, Encoding.UTF8));
            if (value == null) throw new InvalidOperationException("配置文件无法读取");
            if (value.Host == null) value.Host = new HostConfiguration();
            if (value.Connections == null) value.Connections = new List<ConnectionConfiguration>();
            return value;
        }

        public void Save(AssistantConfiguration value)
        {
            Directory.CreateDirectory(_root);
            WriteAtomic(_configurationPath, Encoding.UTF8.GetBytes(_json.Serialize(value)));
        }

        public bool HasSecret(string key)
        {
            return LoadSecrets().ContainsKey(key);
        }

        public string GetSecret(string key)
        {
            string value;
            return LoadSecrets().TryGetValue(key, out value) ? value : null;
        }

        public void SetSecret(string key, string value)
        {
            if (String.IsNullOrWhiteSpace(key)) throw new ArgumentException("密钥名称不能为空");
            var secrets = LoadSecrets();
            if (String.IsNullOrWhiteSpace(value)) secrets.Remove(key);
            else secrets[key] = value.Trim();
            var plain = Encoding.UTF8.GetBytes(_json.Serialize(secrets));
            var encrypted = ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine);
            WriteAtomic(_secretsPath, encrypted);
        }

        private Dictionary<string, string> LoadSecrets()
        {
            if (!File.Exists(_secretsPath)) return new Dictionary<string, string>();
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(_secretsPath), Entropy, DataProtectionScope.LocalMachine);
            return _json.Deserialize<Dictionary<string, string>>(Encoding.UTF8.GetString(plain)) ?? new Dictionary<string, string>();
        }

        private static void WriteAtomic(string path, byte[] bytes)
        {
            var temp = path + ".tmp";
            var backup = path + ".previous";
            File.WriteAllBytes(temp, bytes);
            if (File.Exists(path))
            {
                File.Copy(path, backup, true);
                File.Delete(path);
            }
            File.Move(temp, path);
        }
    }
}
