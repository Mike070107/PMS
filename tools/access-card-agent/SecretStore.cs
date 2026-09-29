using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Pms.AccessCardAgent
{
    internal static class SecretStore
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PMS.AccessCardAgent.v1");

        public static void Save(string path, string token)
        {
            if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("代理密钥不能为空");
            var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(token.Trim()), Entropy, DataProtectionScope.LocalMachine);
            File.WriteAllBytes(path, encrypted);
        }

        public static string Load(string path)
        {
            if (!File.Exists(path)) throw new InvalidOperationException("代理密钥尚未安装，请先运行 --install-token");
            var decrypted = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(decrypted);
        }

        public static string ReadHidden()
        {
            var value = new StringBuilder();
            ConsoleKeyInfo key;
            while ((key = Console.ReadKey(true)).Key != ConsoleKey.Enter)
            {
                if (key.Key == ConsoleKey.Backspace && value.Length > 0) value.Length--;
                else if (!Char.IsControl(key.KeyChar)) value.Append(key.KeyChar);
            }
            Console.WriteLine();
            return value.ToString();
        }
    }
}
