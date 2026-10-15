using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

namespace Pms.AccessCardAgent
{
    internal enum PropertyCardState { UnencryptedBlank, Initialized, Authorized, ForeignOrDamaged }
    internal sealed class CardInspection
    {
        public string Uid { get; set; }
        public int? IcNo { get; set; }
        public PropertyCardState State { get; set; }
        public string Message { get; set; }
        internal byte[][] Blocks { get; set; }
    }

    /** ACR122U PC/SC 适配器：枚举、认证、读块、写块和逐块回读均在这一处实现。 */
    internal static class CardReader
    {
        private const uint ScopeSystem = 2, ShareShared = 2, ProtocolT0 = 1, ProtocolT1 = 2;
        private const string DefaultKey = "FFFFFFFFFFFF";
        [StructLayout(LayoutKind.Sequential)] private struct ScardIoRequest { public uint Protocol; public uint PciLength; }
        [DllImport("winscard.dll")] private static extern int SCardEstablishContext(uint scope, IntPtr r1, IntPtr r2, out IntPtr context);
        [DllImport("winscard.dll", CharSet = CharSet.Unicode)] private static extern int SCardListReaders(IntPtr context, string groups, char[] readers, ref int length);
        [DllImport("winscard.dll")] private static extern int SCardReleaseContext(IntPtr context);
        [DllImport("winscard.dll", CharSet = CharSet.Unicode)] private static extern int SCardConnect(IntPtr context, string reader, uint share, uint protocols, out IntPtr card, out uint activeProtocol);
        [DllImport("winscard.dll")] private static extern int SCardTransmit(IntPtr card, ref ScardIoRequest pci, byte[] input, int inputLength, IntPtr receivePci, byte[] output, ref int outputLength);
        [DllImport("winscard.dll")] private static extern int SCardDisconnect(IntPtr card, uint disposition);

        private sealed class Session : IDisposable
        {
            private readonly IntPtr _context, _card;
            private readonly uint _protocol;
            public Session(string reader)
            {
                var result = SCardEstablishContext(ScopeSystem, IntPtr.Zero, IntPtr.Zero, out _context);
                if (result != 0) throw new InvalidOperationException("PC/SC 初始化失败：" + result);
                result = SCardConnect(_context, reader, ShareShared, ProtocolT0 | ProtocolT1, out _card, out _protocol);
                if (result != 0) { SCardReleaseContext(_context); throw new InvalidOperationException("请将门禁卡放到 ACR122U 上"); }
            }
            public byte[] Transmit(byte[] command)
            {
                var request = new ScardIoRequest { Protocol = _protocol, PciLength = (uint)Marshal.SizeOf(typeof(ScardIoRequest)) };
                var response = new byte[64]; var length = response.Length;
                var result = SCardTransmit(_card, ref request, command, command.Length, IntPtr.Zero, response, ref length);
                if (result != 0) throw new InvalidOperationException("PC/SC 传输失败：0x" + result.ToString("X8"));
                Array.Resize(ref response, length); return response;
            }
            public void Dispose() { SCardDisconnect(_card, 0); SCardReleaseContext(_context); }
        }

        public static string[] ListReaders()
        {
            IntPtr context; var result = SCardEstablishContext(ScopeSystem, IntPtr.Zero, IntPtr.Zero, out context);
            if (result != 0) return new string[0];
            try
            {
                var length = 0; result = SCardListReaders(context, null, null, ref length);
                if (result != 0 || length <= 1) return new string[0];
                var buffer = new char[length]; result = SCardListReaders(context, null, buffer, ref length);
                return result == 0 ? new string(buffer).Split('\0').Where(v => !String.IsNullOrWhiteSpace(v)).Select(v => v.Trim()).ToArray() : new string[0];
            }
            finally { SCardReleaseContext(context); }
        }

        public static bool HasAcr122() { return ListReaders().Any(r => r.IndexOf("ACR122", StringComparison.OrdinalIgnoreCase) >= 0); }
        public static string ReadUid() { using (var s = Open()) return Payload(s.Transmit(new byte[] { 0xFF, 0xCA, 0, 0, 0 }), "无法读取卡号"); }
        public static CardInspection Inspect(CardProfileSet profiles) { using (var s = Open()) return Inspect(s, profiles); }
        public static CardInspection Inspect(CardProfileSet profiles, string readKey) { using (var s = Open()) return Inspect(s, profiles, readKey); }

        public static CardInspection InitializeBlank(CardProfileSet profiles)
        {
            var initialized = profiles.Initialized.Block(48);
            return Initialize(profiles, (initialized[0] << 8) | initialized[1]);
        }

        public static CardInspection InitializeBlank(CardProfileSet profiles, string readKey, string targetKey)
        {
            var effective = CardProfiles.WithUniformTargetKey(profiles, targetKey);
            var initialized = effective.Initialized.Block(48);
            return Initialize(effective, (initialized[0] << 8) | initialized[1], readKey);
        }

        internal static CardInspection Initialize(CardProfileSet profiles, int icNo)
        {
            return Initialize(profiles, icNo, DefaultKey);
        }

        private static CardInspection Initialize(CardProfileSet profiles, int icNo, string readKey)
        {
            if (icNo < 1 || icNo > 65535) throw new InvalidOperationException("ICNO 必须在 1–65535 之间");
            using (var s = Open())
            {
                var before = Inspect(s, profiles, readKey);
                if (before.State != PropertyCardState.UnencryptedBlank) throw new InvalidOperationException("只允许初始化未加密空白卡，当前：" + before.Message);
                WriteAndVerify(s, before.Blocks, Materialize(profiles.Initialized, icNo), profiles);
                var after = Inspect(s, profiles);
                if (after.State != PropertyCardState.Initialized || after.IcNo != icNo) throw new InvalidOperationException("初始化回读结果不符合枫桦景苑加密卡规则");
                return after;
            }
        }

        public static CardInspection AuthorizeMainGate(CardProfileSet profiles, int icNo)
        {
            if (icNo < 1 || icNo > 65535) throw new InvalidOperationException("ICNO 必须在 1–65535 之间");
            using (var s = Open())
            {
                var before = Inspect(s, profiles);
                if (before.State != PropertyCardState.Initialized || !before.IcNo.HasValue) throw new InvalidOperationException("只允许对枫桦景苑已加密初始卡授权，当前：" + before.Message);
                WriteAndVerify(s, before.Blocks, Materialize(profiles.Authorized, icNo), profiles);
                var after = Inspect(s, profiles);
                if (after.State != PropertyCardState.Authorized || after.IcNo != icNo) throw new InvalidOperationException("大铁门授权回读校验失败");
                return after;
            }
        }

        private static CardInspection Inspect(Session s, CardProfileSet profiles) { return Inspect(s, profiles, DefaultKey); }

        private static CardInspection Inspect(Session s, CardProfileSet profiles, string readKey)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(readKey ?? "", "^[0-9A-Fa-f]{12}$")) throw new InvalidOperationException("默认读取密钥必须是12位十六进制");
            var uid = Payload(s.Transmit(new byte[] { 0xFF, 0xCA, 0, 0, 0 }), "无法读取卡号");
            var keys = CandidateKeys(profiles).Concat(new[] { readKey.ToUpperInvariant() }).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(); var blocks = new byte[64][]; var selected = new string[16];
            for (var sector = 0; sector < 16; sector++)
                foreach (var key in keys)
                {
                    if (!Authenticate(s, sector * 4, key, 0x60) && !Authenticate(s, sector * 4, key, 0x61)) continue;
                    selected[sector] = key;
                    for (var offset = 0; offset < 3; offset++) blocks[sector * 4 + offset] = ReadBlock(s, sector * 4 + offset);
                    break;
                }
            if (selected.Any(String.IsNullOrEmpty)) return Result(uid, null, PropertyCardState.ForeignOrDamaged, "读取密钥不匹配，或卡片损坏（未能认证全部扇区）", blocks);
            if (selected.All(k => String.Equals(k, readKey, StringComparison.OrdinalIgnoreCase)) && Matches(blocks, profiles.Blank, false)) return Result(uid, null, PropertyCardState.UnencryptedBlank, "默认读取密钥正确：未加密空白卡", blocks);
            var icNo = blocks[48] == null ? (int?)null : (blocks[48][0] << 8) | blocks[48][1];
            if (!MatchesPropertyKeyLayout(selected, profiles.Initialized)) return Result(uid, icNo, PropertyCardState.ForeignOrDamaged, "非本小区卡或卡片密钥不匹配", blocks);
            if (Matches(blocks, profiles.Authorized, true)) return Result(uid, icNo, PropertyCardState.Authorized, "枫桦景苑大铁门有效卡", blocks);
            if (Matches(blocks, profiles.Initialized, true)) return Result(uid, icNo, PropertyCardState.Initialized, "枫桦景苑已加密初始卡（未授权）", blocks);
            return Result(uid, icNo, PropertyCardState.ForeignOrDamaged, "非本小区卡或数据不完整", blocks);
        }

        private static void WriteAndVerify(Session s, byte[][] current, byte[][] target, CardProfileSet profiles)
        {
            for (var sector = 1; sector < 16; sector++) // 整个 0 扇区不写，避免制造商块风险。
            {
                var key = FindWorkingKey(s, sector * 4, CandidateKeys(profiles));
                for (var offset = 0; offset < 3; offset++)
                {
                    var block = sector * 4 + offset;
                    if (current[block] != null && current[block].SequenceEqual(target[block])) continue;
                    RequireAuthenticate(s, block, key); WriteBlock(s, block, target[block]); RequireAuthenticate(s, block, key);
                    if (!ReadBlock(s, block).SequenceEqual(target[block])) throw new InvalidOperationException("卡块 " + block + " 写入后回读不一致");
                }
                var trailer = sector * 4 + 3;
                if (!TrailerEquivalent(key, target[trailer]))
                {
                    RequireAuthenticate(s, trailer, key); WriteBlock(s, trailer, target[trailer]);
                    var nextKey = CardProfiles.Hex(target[trailer].Take(6).ToArray()); RequireAuthenticate(s, sector * 4, nextKey);
                    if (!ReadBlock(s, sector * 4).SequenceEqual(target[sector * 4])) throw new InvalidOperationException("扇区 " + sector + " 更换密钥后回读失败");
                }
            }
        }

        private static byte[][] Materialize(CardProfile profile, int icNo)
        {
            var blocks = Enumerable.Range(0, 64).Select(profile.Block).ToArray();
            foreach (var block in new[] { 48, 52, 56, 60 }) { blocks[block][0] = (byte)(icNo >> 8); blocks[block][1] = (byte)icNo; }
            return blocks;
        }

        private static bool Matches(byte[][] actual, CardProfile profile, bool dynamicIcNo)
        {
            for (var block = 1; block < 64; block++)
            {
                if (block % 4 == 3) continue; if (actual[block] == null) return false;
                var expected = profile.Block(block); var start = dynamicIcNo && new[] { 48, 52, 56, 60 }.Contains(block) ? 2 : 0;
                for (var i = start; i < 16; i++) if (actual[block][i] != expected[i]) return false;
            }
            return true;
        }

        private static bool MatchesPropertyKeyLayout(string[] selected, CardProfile profile)
        {
            for (var sector = 0; sector < 16; sector++)
            {
                var t = profile.Block(sector * 4 + 3); var a = CardProfiles.Hex(t.Take(6).ToArray()); var b = CardProfiles.Hex(t.Skip(10).Take(6).ToArray());
                if (selected[sector] != a && selected[sector] != b) return false;
            }
            return true;
        }

        private static IEnumerable<string> CandidateKeys(CardProfileSet profiles)
        {
            var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { DefaultKey };
            foreach (var profile in new[] { profiles.Blank, profiles.Initialized, profiles.Authorized })
                for (var sector = 0; sector < 16; sector++) { var t = profile.Block(sector * 4 + 3); keys.Add(CardProfiles.Hex(t.Take(6).ToArray())); keys.Add(CardProfiles.Hex(t.Skip(10).Take(6).ToArray())); }
            return keys;
        }

        private static string FindWorkingKey(Session s, int block, IEnumerable<string> keys) { foreach (var key in keys) if (Authenticate(s, block, key, 0x60) || Authenticate(s, block, key, 0x61)) return key; throw new InvalidOperationException("卡块 " + block + " 认证失败"); }
        private static bool Authenticate(Session s, int block, string key, byte type)
        {
            var bytes = CardProfiles.Hex(key); var load = new byte[11]; load[0] = 0xFF; load[1] = 0x82; load[4] = 6; Array.Copy(bytes, 0, load, 5, 6);
            return Ok(s.Transmit(load)) && Ok(s.Transmit(new byte[] { 0xFF, 0x86, 0, 0, 5, 1, 0, (byte)block, type, 0 }));
        }
        private static void RequireAuthenticate(Session s, int block, string key) { if (!Authenticate(s, block, key, 0x60) && !Authenticate(s, block, key, 0x61)) throw new InvalidOperationException("卡块 " + block + " 认证失败"); }
        private static byte[] ReadBlock(Session s, int block) { var r = s.Transmit(new byte[] { 0xFF, 0xB0, 0, (byte)block, 0x10 }); if (!Ok(r) || r.Length != 18) throw new InvalidOperationException("卡块 " + block + " 读取失败"); return r.Take(16).ToArray(); }
        private static void WriteBlock(Session s, int block, byte[] data) { if (block == 0) throw new InvalidOperationException("禁止写入制造商块 0"); var c = new byte[21]; c[0] = 0xFF; c[1] = 0xD6; c[3] = (byte)block; c[4] = 0x10; Array.Copy(data, 0, c, 5, 16); if (!Ok(s.Transmit(c))) throw new InvalidOperationException("卡块 " + block + " 写入失败"); }
        private static bool TrailerEquivalent(string key, byte[] trailer) { return key == CardProfiles.Hex(trailer.Take(6).ToArray()) || key == CardProfiles.Hex(trailer.Skip(10).Take(6).ToArray()); }
        private static Session Open() { var reader = ListReaders().FirstOrDefault(r => r.IndexOf("ACR122", StringComparison.OrdinalIgnoreCase) >= 0); if (reader == null) throw new InvalidOperationException("未检测到 ACR122U"); return new Session(reader); }
        private static bool Ok(byte[] r) { return r.Length >= 2 && r[r.Length - 2] == 0x90 && r[r.Length - 1] == 0; }
        private static string Payload(byte[] r, string error) { if (!Ok(r)) throw new InvalidOperationException(error); return CardProfiles.Hex(r.Take(r.Length - 2).ToArray()); }
        private static CardInspection Result(string uid, int? icNo, PropertyCardState state, string message, byte[][] blocks) { return new CardInspection { Uid = uid, IcNo = icNo, State = state, Message = message, Blocks = blocks }; }
    }
}
