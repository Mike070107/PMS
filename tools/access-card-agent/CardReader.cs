using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Pms.AccessCardAgent
{
    /** PC/SC 设备发现与只读 UID；真实扇区写入在卡片镜像差异验证后再解锁。 */
    internal static class CardReader
    {
        private const uint ScopeSystem = 2;
        private const uint ShareShared = 2;
        private const uint ProtocolT0 = 1;
        private const uint ProtocolT1 = 2;

        [StructLayout(LayoutKind.Sequential)]
        private struct ScardIoRequest
        {
            public uint Protocol;
            public uint PciLength;
        }

        [DllImport("winscard.dll")]
        private static extern int SCardEstablishContext(uint scope, IntPtr reserved1, IntPtr reserved2, out IntPtr context);

        [DllImport("winscard.dll", CharSet = CharSet.Unicode)]
        private static extern int SCardListReaders(IntPtr context, string groups, char[] readers, ref int length);

        [DllImport("winscard.dll")]
        private static extern int SCardReleaseContext(IntPtr context);

        [DllImport("winscard.dll", CharSet = CharSet.Unicode)]
        private static extern int SCardConnect(IntPtr context, string reader, uint shareMode, uint preferredProtocols, out IntPtr card, out uint activeProtocol);

        [DllImport("winscard.dll")]
        private static extern int SCardTransmit(IntPtr card, ref ScardIoRequest sendPci, byte[] sendBuffer, int sendLength, IntPtr receivePci, byte[] receiveBuffer, ref int receiveLength);

        [DllImport("winscard.dll")]
        private static extern int SCardDisconnect(IntPtr card, uint disposition);

        public static string[] ListReaders()
        {
            IntPtr context;
            var result = SCardEstablishContext(ScopeSystem, IntPtr.Zero, IntPtr.Zero, out context);
            if (result != 0) return new string[0];
            try
            {
                var length = 0;
                result = SCardListReaders(context, null, null, ref length);
                if (result != 0 || length <= 1) return new string[0];
                var buffer = new char[length];
                result = SCardListReaders(context, null, buffer, ref length);
                if (result != 0) return new string[0];
                var readers = new List<string>();
                foreach (var value in new string(buffer).Split('\0'))
                    if (!String.IsNullOrWhiteSpace(value)) readers.Add(value.Trim());
                return readers.ToArray();
            }
            finally { SCardReleaseContext(context); }
        }

        public static bool HasAcr122()
        {
            foreach (var reader in ListReaders())
                if (reader.IndexOf("ACR122", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        public static string ReadUid()
        {
            string selected = null;
            foreach (var reader in ListReaders())
                if (reader.IndexOf("ACR122", StringComparison.OrdinalIgnoreCase) >= 0) { selected = reader; break; }
            if (selected == null) throw new InvalidOperationException("未检测到 ACR122U");

            IntPtr context;
            var result = SCardEstablishContext(ScopeSystem, IntPtr.Zero, IntPtr.Zero, out context);
            if (result != 0) throw new InvalidOperationException("PC/SC 初始化失败：" + result);
            try
            {
                IntPtr card;
                uint protocol;
                result = SCardConnect(context, selected, ShareShared, ProtocolT0 | ProtocolT1, out card, out protocol);
                if (result != 0) throw new InvalidOperationException("请将门禁卡放到 ACR122U 上");
                try
                {
                    var request = new ScardIoRequest { Protocol = protocol, PciLength = (uint)Marshal.SizeOf(typeof(ScardIoRequest)) };
                    var command = new byte[] { 0xFF, 0xCA, 0x00, 0x00, 0x00 };
                    var response = new byte[32];
                    var responseLength = response.Length;
                    result = SCardTransmit(card, ref request, command, command.Length, IntPtr.Zero, response, ref responseLength);
                    if (result != 0 || responseLength < 3 || response[responseLength - 2] != 0x90 || response[responseLength - 1] != 0x00)
                        throw new InvalidOperationException("无法读取卡号，请重新放卡");
                    return BitConverter.ToString(response, 0, responseLength - 2).Replace("-", "");
                }
                finally { SCardDisconnect(card, 0); }
            }
            finally { SCardReleaseContext(context); }
        }
    }
}
