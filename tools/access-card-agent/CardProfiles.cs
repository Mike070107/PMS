using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Pms.AccessCardAgent
{
    internal sealed class CardProfile
    {
        public string Name { get; set; }
        public string[] Blocks { get; set; }

        public byte[] Block(int index)
        {
            if (Blocks == null || Blocks.Length != 64) throw new InvalidOperationException(Name + " 卡片模板不完整");
            return CardProfiles.Hex(Blocks[index]);
        }
    }

    internal sealed class CardProfileSet
    {
        public CardProfile Blank { get; set; }
        public CardProfile Initialized { get; set; }
        public CardProfile Authorized { get; set; }
    }

    /**
     * 卡片模板只存在发卡电脑的 DPAPI 密文中；不进 Git、API 或日志。
     */
    internal static class CardProfiles
    {
        public const string ProtectedFileName = "access-card-profiles.dat";
        public const string EmbeddedSeedResource = "Pms.AccessCardAgent.access-card-profiles.seed";
        private static readonly Regex BlockLine = new Regex(
            @"(?im)^\s*\d+\s+[^:]*:\s*((?:[0-9A-F]{2}\s+){15}[0-9A-F]{2})\s*$",
            RegexOptions.Compiled);

        public static void Install(string protectedPath, string blankPath, string initializedPath, string authorizedPath)
        {
            var profiles = new CardProfileSet
            {
                Blank = Parse("未加密空白卡", blankPath),
                Initialized = Parse("枫桦景苑已加密初始卡", initializedPath),
                Authorized = Parse("枫桦景苑大铁门授权卡", authorizedPath)
            };
            Validate(profiles);
            SecretStore.Save(protectedPath, new JavaScriptSerializer().Serialize(profiles));
        }

        public static CardProfileSet Load(string protectedPath)
        {
            if (!File.Exists(protectedPath)) InstallEmbeddedSeed(protectedPath);
            var profiles = new JavaScriptSerializer().Deserialize<CardProfileSet>(SecretStore.Load(protectedPath));
            Validate(profiles);
            return profiles;
        }

        public static void BuildPortableSeed(string seedPath, string blankPath, string initializedPath, string authorizedPath)
        {
            var profiles = new CardProfileSet
            {
                Blank = Parse("未加密空白卡", blankPath),
                Initialized = Parse("枫桦景苑已加密初始卡", initializedPath),
                Authorized = Parse("枫桦景苑大铁门授权卡", authorizedPath)
            };
            Validate(profiles);
            var plain = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(profiles));
            using (var aes = new AesManaged { Key = PortableKey(), Mode = CipherMode.CBC, Padding = PaddingMode.PKCS7 })
            {
                aes.GenerateIV();
                using (var output = new MemoryStream())
                {
                    output.Write(aes.IV, 0, aes.IV.Length);
                    using (var crypto = new CryptoStream(output, aes.CreateEncryptor(), CryptoStreamMode.Write))
                    {
                        crypto.Write(plain, 0, plain.Length);
                        crypto.FlushFinalBlock();
                    }
                    File.WriteAllBytes(seedPath, output.ToArray());
                }
            }
        }

        private static void InstallEmbeddedSeed(string protectedPath)
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(EmbeddedSeedResource))
            {
                if (stream == null) throw new InvalidOperationException("当前助手未包含枫桦景苑卡片模板，请重新下载正式版本");
                var payload = new byte[stream.Length];
                var read = stream.Read(payload, 0, payload.Length);
                if (read != payload.Length || payload.Length <= 16) throw new InvalidOperationException("内置卡片模板损坏");
                var iv = payload.Take(16).ToArray();
                using (var aes = new AesManaged { Key = PortableKey(), IV = iv, Mode = CipherMode.CBC, Padding = PaddingMode.PKCS7 })
                using (var input = new MemoryStream(payload, 16, payload.Length - 16))
                using (var crypto = new CryptoStream(input, aes.CreateDecryptor(), CryptoStreamMode.Read))
                using (var output = new MemoryStream())
                {
                    crypto.CopyTo(output);
                    var json = Encoding.UTF8.GetString(output.ToArray());
                    var profiles = new JavaScriptSerializer().Deserialize<CardProfileSet>(json);
                    Validate(profiles);
                    SecretStore.Save(protectedPath, json);
                }
            }
        }

        private static byte[] PortableKey()
        {
            using (var sha = SHA256.Create())
                return sha.ComputeHash(Encoding.UTF8.GetBytes("PMS-FHJY-ACR122U-PROFILE-SEED-v1"));
        }

        private static CardProfile Parse(string name, string path)
        {
            if (!File.Exists(path)) throw new FileNotFoundException("找不到卡片数据", path);
            var blocks = BlockLine.Matches(File.ReadAllText(path))
                .Cast<Match>()
                .Select(match => Regex.Replace(match.Groups[1].Value, @"\s", "").ToUpperInvariant())
                .ToArray();
            if (blocks.Length != 64) throw new InvalidOperationException(path + " 应包含 64 个卡块，实际为 " + blocks.Length);
            return new CardProfile { Name = name, Blocks = blocks };
        }

        private static void Validate(CardProfileSet profiles)
        {
            if (profiles == null || profiles.Blank == null || profiles.Initialized == null || profiles.Authorized == null)
                throw new InvalidOperationException("卡片模板缺少空白、初始化或授权阶段");
            foreach (var profile in new[] { profiles.Blank, profiles.Initialized, profiles.Authorized })
            {
                if (profile.Blocks == null || profile.Blocks.Length != 64 || profile.Blocks.Any(value => !Regex.IsMatch(value ?? "", "^[0-9A-F]{32}$")))
                    throw new InvalidOperationException(profile.Name + " 卡片模板格式无效");
            }
            if (profiles.Blank.Blocks[0] == profiles.Initialized.Blocks[0])
                throw new InvalidOperationException("空白卡和初始卡样本必须来自不同实体卡");
        }

        internal static byte[] Hex(string value)
        {
            var result = new byte[value.Length / 2];
            for (var i = 0; i < result.Length; i++) result[i] = Convert.ToByte(value.Substring(i * 2, 2), 16);
            return result;
        }

        internal static string Hex(byte[] value)
        {
            return BitConverter.ToString(value).Replace("-", "");
        }

        internal static CardProfileSet WithUniformTargetKey(CardProfileSet source, string key)
        {
            if (!Regex.IsMatch(key ?? "", "^[0-9A-Fa-f]{12}$")) throw new InvalidOperationException("目标写入密钥必须是12位十六进制");
            var normalized = key.ToUpperInvariant();
            Func<CardProfile, CardProfile> copy = delegate(CardProfile profile)
            {
                var blocks = profile.Blocks.ToArray();
                for (var sector = 0; sector < 16; sector++)
                {
                    var trailer = blocks[sector * 4 + 3];
                    blocks[sector * 4 + 3] = normalized + trailer.Substring(12, 8) + normalized;
                }
                return new CardProfile { Name = profile.Name, Blocks = blocks };
            };
            return new CardProfileSet { Blank = source.Blank, Initialized = copy(source.Initialized), Authorized = copy(source.Authorized) };
        }
    }
}
