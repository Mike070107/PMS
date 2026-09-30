using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using Pms.AccessCardAgent;

namespace Pms.DataSyncAssistant
{
    internal sealed class ActivityRecord
    {
        public string Id { get; set; }
        public string ConnectionId { get; set; }
        public string ConnectionName { get; set; }
        public string OccurredAt { get; set; }
        public string Operation { get; set; }
        public string Target { get; set; }
        public bool Success { get; set; }
        public string Message { get; set; }
    }

    internal static class ActivityStore
    {
        private const int MaximumRecords = 100;
        private static readonly object Sync = new object();

        public static void Record(string rootPath, string connectionId, string connectionName, AgentActivity activity)
        {
            if (activity == null) return;
            lock (Sync)
            {
                Directory.CreateDirectory(rootPath);
                var records = LoadUnsafe(rootPath);
                records.Insert(0, new ActivityRecord
                {
                    Id = Guid.NewGuid().ToString("N"),
                    ConnectionId = connectionId,
                    ConnectionName = connectionName,
                    OccurredAt = activity.OccurredAt.ToString("o"),
                    Operation = activity.Operation,
                    Target = activity.Target,
                    Success = activity.Success,
                    Message = activity.Message
                });
                if (records.Count > MaximumRecords) records.RemoveRange(MaximumRecords, records.Count - MaximumRecords);
                WriteAtomic(Path.Combine(rootPath, "activities.json"), new JavaScriptSerializer().Serialize(records));
            }
        }

        public static List<ActivityRecord> Load(string rootPath)
        {
            lock (Sync) return LoadUnsafe(rootPath);
        }

        private static List<ActivityRecord> LoadUnsafe(string rootPath)
        {
            var path = Path.Combine(rootPath, "activities.json");
            if (!File.Exists(path)) return new List<ActivityRecord>();
            try
            {
                return new JavaScriptSerializer().Deserialize<List<ActivityRecord>>(File.ReadAllText(path, Encoding.UTF8))
                    ?? new List<ActivityRecord>();
            }
            catch
            {
                var backup = path + ".previous";
                if (!File.Exists(backup)) return new List<ActivityRecord>();
                return new JavaScriptSerializer().Deserialize<List<ActivityRecord>>(File.ReadAllText(backup, Encoding.UTF8))
                    ?? new List<ActivityRecord>();
            }
        }

        private static void WriteAtomic(string path, string value)
        {
            var temporary = path + ".new";
            File.WriteAllText(temporary, value, Encoding.UTF8);
            if (File.Exists(path)) File.Replace(temporary, path, path + ".previous", true);
            else File.Move(temporary, path);
        }
    }

    public sealed class ActivityViewModel
    {
        private readonly ActivityRecord _record;
        internal ActivityViewModel(ActivityRecord record) { _record = record; }
        public string Time
        {
            get
            {
                DateTimeOffset value;
                return DateTimeOffset.TryParse(_record.OccurredAt, out value) ? value.LocalDateTime.ToString("MM-dd HH:mm:ss") : _record.OccurredAt;
            }
        }
        public string Title { get { return _record.Operation + (String.IsNullOrWhiteSpace(_record.Target) ? "" : " · " + _record.Target); } }
        public string Detail { get { return _record.ConnectionName + " · " + _record.Message; } }
        public string StatusText { get { return _record.Success ? "成功" : "失败"; } }
        public string StatusBackground { get { return _record.Success ? "#E8F6EF" : "#FCEBEC"; } }
        public string StatusForeground { get { return _record.Success ? "#24775F" : "#A43C45"; } }
    }
}
