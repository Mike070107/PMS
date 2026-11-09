using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.Linq;

namespace Pms.AccessCardAgent
{
    internal sealed class NormalizedIcCardNumber
    {
        public string value { get; set; }
        public string warning { get; set; }
    }

    /**
     * iCCard 的 WG 卡号规则（2026-11-07 用户确认）：
     * - PMS/API/页面仍然传 8 位（如 05108721）；
     * - 只有写 iCCard 数据库时去掉前导 0（5108721、108721）；
     * - MjSystem / 捷顺保持原样，不能套用本规则；
     * - 去零后为空（全 0）保留一个 "0" 写入，并产生 warning 供审计/活动日志；
     *   "10000000" 只去前导 0，不能误删中间 0。
     */
    internal static class IcCardNumber
    {
        public static NormalizedIcCardNumber NormalizeForWrite(string wgCardNo)
        {
            var raw = (wgCardNo ?? "").Trim();
            if (raw.Length == 0) throw new InvalidOperationException("WG 卡号不能为空");
            if (!raw.All(Char.IsDigit)) throw new InvalidOperationException("WG 卡号必须是纯数字");
            var stripped = raw.TrimStart('0');
            if (stripped.Length == 0)
            {
                return new NormalizedIcCardNumber
                {
                    value = "0",
                    warning = "WG 卡号 " + raw + " 去前导零后为空，已按 0 写入 iCCard；请核对卡片数据"
                };
            }
            return new NormalizedIcCardNumber
            {
                value = stripped,
                warning = String.Equals(stripped, raw, StringComparison.Ordinal)
                    ? null
                    : "WG 卡号 " + raw + " 写入 iCCard 时按规则去前导零为 " + stripped
            };
        }

        /** MjSystem/捷顺不转换；只有 iCCard 去前导零。 */
        public static string ForSystem(string accessSystem, string wgCardNo)
        {
            return String.Equals(accessSystem, "iccard", StringComparison.OrdinalIgnoreCase)
                ? NormalizeForWrite(wgCardNo).value
                : (wgCardNo ?? "").Trim();
        }

        /**
         * 读取/比对 iCCard 时的候选值：
         * 优先去零值（新写入），同时保留原 8 位/补 8 位以兼容历史 7/8 位混用数据。
         * 全 0 时返回 "0" + "00000000"，不会产生空串。
         */
        public static string[] QueryVariants(string wgCardNo)
        {
            var raw = (wgCardNo ?? "").Replace(" ", "").Trim();
            if (raw.Length == 0) return new[] { "0" };
            var values = new List<string>();
            if (raw.All(Char.IsDigit))
            {
                var stripped = raw.TrimStart('0');
                if (stripped.Length > 0) values.Add(stripped);
                else values.Add("0");
            }
            values.Add(raw);
            if (raw.All(Char.IsDigit) && raw.Length < 8) values.Add(raw.PadLeft(8, '0'));
            return values.Where(value => !String.IsNullOrEmpty(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        public static string Placeholders(int count)
        {
            if (count <= 0) throw new InvalidOperationException("WG 卡号查询候选为空");
            return String.Join(",", Enumerable.Repeat("?", count).ToArray());
        }

        public static void AddQueryParameters(OleDbCommand command, string wgCardNo)
        {
            foreach (var variant in QueryVariants(wgCardNo))
                command.Parameters.AddWithValue("@card", variant);
        }
    }
}
