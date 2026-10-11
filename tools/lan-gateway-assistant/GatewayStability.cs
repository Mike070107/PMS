using System;
using System.Collections.Generic;

namespace Pms.LanGatewayAssistant
{
    /**
     * 每轮探测的结果原来只活在后台服务进程里，回报完心跳就丢掉，所以助手界面
     * 只能显示配置里的 Enabled 标志位——一个内网应用明明已经连不上，界面上仍
     * 写着「本机已启用」，和 PMS 上的「需处理」对不上。这里把探测结果按分钟
     * 汇总落盘，界面进程直接读，两边才会对同一件事说同一句话。
     */
    internal static class GatewayStabilityLog
    {
        internal const int MaximumMinutes = 120;
        internal static readonly TimeSpan AvailabilityWindow = TimeSpan.FromHours(1);

        internal static GatewayStability Merge(GatewayStability previous, IList<GatewayRoute> routes, IList<GatewayRouteReport> reports, DateTimeOffset now)
        {
            var result = new GatewayStability
            {
                CheckedAt = now.ToString("o"),
                TunnelRestarts = previous == null ? 0 : previous.TunnelRestarts,
                LastRestartAt = previous == null ? null : previous.LastRestartAt,
                Routes = new List<GatewayRouteHealth>()
            };
            var history = Index(previous);
            var observed = new Dictionary<string, GatewayRouteReport>(StringComparer.OrdinalIgnoreCase);
            if (reports != null)
                foreach (var report in reports)
                    if (report != null) observed[KeyOf(report.Id, report.AppId)] = report;
            if (routes != null)
                foreach (var route in routes)
                {
                    if (route == null) continue;
                    var key = KeyOf(route.Id, route.AppId);
                    GatewayRouteHealth entry; history.TryGetValue(key, out entry);
                    GatewayRouteReport report; observed.TryGetValue(key, out report);
                    result.Routes.Add(Advance(entry, route, report, now));
                }
            return result;
        }

        internal static GatewayStability RecordRestart(GatewayStability previous, DateTimeOffset now)
        {
            var value = previous ?? new GatewayStability();
            if (value.Routes == null) value.Routes = new List<GatewayRouteHealth>();
            value.TunnelRestarts += 1;
            value.LastRestartAt = now.ToString("o");
            return value;
        }

        internal static GatewayRouteHealth Find(GatewayStability stability, GatewayRoute route)
        {
            if (stability == null || stability.Routes == null || route == null) return null;
            var key = KeyOf(route.Id, route.AppId);
            foreach (var item in stability.Routes)
                if (item != null && String.Equals(KeyOf(item.Id, item.AppId), key, StringComparison.OrdinalIgnoreCase)) return item;
            return null;
        }

        /** 最近一小时的可用率；这段时间内没有任何样本时返回 null，不拿 100% 充数。 */
        internal static double? Availability(GatewayRouteHealth health, DateTimeOffset now, TimeSpan window)
        {
            if (health == null || health.Minutes == null) return null;
            var floor = now.Subtract(window);
            var checks = 0;
            var failures = 0;
            foreach (var minute in health.Minutes)
            {
                DateTimeOffset at;
                if (minute == null || !DateTimeOffset.TryParse(minute.Minute, out at) || at < floor) continue;
                checks += minute.Checks;
                failures += minute.Failures;
            }
            if (checks <= 0) return null;
            return (double)(checks - failures) / checks;
        }

        /** 全机结论：把所有启用应用的样本合在一起算，一条坏的会把整体拉下来。 */
        internal static double? OverallAvailability(GatewayStability stability, DateTimeOffset now, TimeSpan window)
        {
            if (stability == null || stability.Routes == null) return null;
            var floor = now.Subtract(window);
            var checks = 0;
            var failures = 0;
            foreach (var route in stability.Routes)
            {
                if (route == null || !route.Enabled || route.Minutes == null) continue;
                foreach (var minute in route.Minutes)
                {
                    DateTimeOffset at;
                    if (minute == null || !DateTimeOffset.TryParse(minute.Minute, out at) || at < floor) continue;
                    checks += minute.Checks;
                    failures += minute.Failures;
                }
            }
            if (checks <= 0) return null;
            return (double)(checks - failures) / checks;
        }

        private static GatewayRouteHealth Advance(GatewayRouteHealth previous, GatewayRoute route, GatewayRouteReport report, DateTimeOffset now)
        {
            var next = new GatewayRouteHealth
            {
                AppId = route.AppId,
                Id = route.Id,
                Name = route.Name,
                Enabled = route.Enabled,
                Minutes = previous == null || previous.Minutes == null ? new List<GatewayHealthMinute>() : new List<GatewayHealthMinute>(previous.Minutes),
                Healthy = previous != null && previous.Healthy,
                Message = previous == null ? null : previous.Message,
                CheckedAt = previous == null ? null : previous.CheckedAt,
                SinceAt = previous == null ? null : previous.SinceAt,
                ConsecutiveFailures = previous == null ? 0 : previous.ConsecutiveFailures,
                LastFailureAt = previous == null ? null : previous.LastFailureAt,
                LastFailureMessage = previous == null ? null : previous.LastFailureMessage
            };
            // 停用的应用这轮没有样本。保留已有历史，但绝不替它编一条「正常」。
            if (report == null) return next;
            if (next.CheckedAt == null || next.Healthy != report.Healthy) next.SinceAt = now.ToString("o");
            next.Healthy = report.Healthy;
            next.Message = report.Message;
            next.CheckedAt = now.ToString("o");
            next.ConsecutiveFailures = report.Healthy ? 0 : next.ConsecutiveFailures + 1;
            if (!report.Healthy) { next.LastFailureAt = now.ToString("o"); next.LastFailureMessage = report.Message; }
            Append(next.Minutes, now, report.Healthy);
            return next;
        }

        private static void Append(List<GatewayHealthMinute> minutes, DateTimeOffset now, bool healthy)
        {
            var stamp = new DateTimeOffset(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, now.Offset).ToString("o");
            var bucket = minutes.Count > 0 ? minutes[minutes.Count - 1] : null;
            if (bucket == null || !String.Equals(bucket.Minute, stamp, StringComparison.Ordinal))
            {
                bucket = new GatewayHealthMinute { Minute = stamp };
                minutes.Add(bucket);
            }
            bucket.Checks += 1;
            if (!healthy) bucket.Failures += 1;
            while (minutes.Count > MaximumMinutes) minutes.RemoveAt(0);
        }

        private static Dictionary<string, GatewayRouteHealth> Index(GatewayStability previous)
        {
            var result = new Dictionary<string, GatewayRouteHealth>(StringComparer.OrdinalIgnoreCase);
            if (previous != null && previous.Routes != null)
                foreach (var item in previous.Routes)
                    if (item != null) result[KeyOf(item.Id, item.AppId)] = item;
            return result;
        }

        /** 手动模式下 AppId 全是 0，必须先用服务器下发的 slug 认人。 */
        private static string KeyOf(string id, int appId)
        {
            return String.IsNullOrWhiteSpace(id) ? "app:" + appId : "id:" + id.Trim();
        }
    }
}
