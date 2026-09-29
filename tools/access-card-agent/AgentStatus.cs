using System;
using System.Globalization;
using System.IO;

namespace Pms.AccessCardAgent
{
    internal static class AgentStatus
    {
        private static readonly string Path = System.IO.Path.Combine(
            AppDomain.CurrentDomain.BaseDirectory, "agent-heartbeat.dat");

        public static void MarkConnected()
        {
            File.WriteAllText(Path, DateTime.UtcNow.Ticks.ToString(CultureInfo.InvariantCulture));
        }

        public static bool IsRecentlyConnected(int maximumAgeMilliseconds)
        {
            try
            {
                long ticks;
                if (!File.Exists(Path) || !Int64.TryParse(File.ReadAllText(Path), out ticks)) return false;
                var age = DateTime.UtcNow - new DateTime(ticks, DateTimeKind.Utc);
                return age.TotalMilliseconds >= 0 && age.TotalMilliseconds <= maximumAgeMilliseconds;
            }
            catch
            {
                return false;
            }
        }
    }
}
