using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Pms.AccessCardAgent
{
    /** 只做 PC/SC 设备发现。真实扇区写入在卡片镜像差异验证后再解锁。 */
    internal static class CardReader
    {
        private const uint ScopeSystem = 2;

        [DllImport("winscard.dll")]
        private static extern int SCardEstablishContext(uint scope, IntPtr reserved1, IntPtr reserved2, out IntPtr context);

        [DllImport("winscard.dll", CharSet = CharSet.Unicode)]
        private static extern int SCardListReaders(IntPtr context, string groups, char[] readers, ref int length);

        [DllImport("winscard.dll")]
        private static extern int SCardReleaseContext(IntPtr context);

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
    }
}
