using System;
using System.Data.OleDb;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;
using Pms.AccessCardAgent;

namespace Pms.DataSyncAssistant
{
    /**
     * 现场一次性验收：仅允许把已由 PMS 建立的测试卡 22345575 改为 3 号楼权限。
     * 入口不在普通界面中暴露，避免误操作其他住户卡。
     */
    internal static class Building3ControllerTest
    {
        private const string TestWgCardNo = "22345575";

        public static string Run()
        {
            var store = new ConfigurationStore();
            var configuration = store.Load();
            var connection = configuration.Connections.FirstOrDefault(item =>
                item.Enabled && String.Equals(item.Type, ConnectionTypes.BuildingAccess, StringComparison.OrdinalIgnoreCase));
            if (connection == null) throw new InvalidOperationException("未找到已启用的“枫桦二期楼栋门禁系统接入”配置");

            var config = ConnectionAgentRuntime.BuildAgentConfig(connection, configuration.Host);
            if (String.IsNullOrWhiteSpace(config.MjSystemDatabasePath) || !File.Exists(config.MjSystemDatabasePath))
                throw new FileNotFoundException("MjSystem 数据库不存在", config.MjSystemDatabasePath);

            var itemId = ReadOwnedPmsItemId(config.MjSystemDatabasePath);
            var backupPath = BackupDatabase(config.MjSystemDatabasePath, store.RootPath);
            var task = new AgentTask
            {
                action = "activate",
                itemId = itemId,
                address = "测试卡1（3号楼门禁）",
                accessSystem = "mjsystem",
                icCardNo = "07B2DF06",
                wgCardNo = TestWgCardNo,
                targetBuildings = new[]
                {
                    new AccessTargetBuilding { id = 3, buildingNo = "3", accessSystem = "mjsystem" }
                }
            };

            var databaseResults = AccessGatewayDatabase.Activate(config, null, task);
            var controllerResults = AccessControllerUploader.Upload(config, null, task);
            string building26Result;
            object unexpectedBuilding26Success = null;
            try
            {
                unexpectedBuilding26Success = AccessControllerUploader.UploadMjSystemDoorForDiagnostic(config, TestWgCardNo, "M0030-1");
                building26Result = "26号楼控制器意外收到并确认了指令，该设备并非离线";
            }
            catch (Exception exception)
            {
                building26Result = exception.Message;
            }
            RemoveOldBuilding26TestRoutes(config.MjSystemDatabasePath, itemId);

            var report = new
            {
                testedAt = DateTimeOffset.Now.ToString("o"),
                card = TestWgCardNo,
                target = "3号楼",
                backup = backupPath,
                database = databaseResults,
                controllers = controllerResults,
                building26OfflineTest = building26Result,
                unexpectedBuilding26Success = unexpectedBuilding26Success,
                removedOldRoutes = new[] { "M0038-1", "M0003-1", "M0030-1" }
            };
            var reportPath = Path.Combine(store.RootPath, "building3-controller-test-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
            File.WriteAllText(reportPath, new JavaScriptSerializer().Serialize(report), Encoding.UTF8);
            return "3号楼门禁下发成功\n\n" +
                   "测试卡：WG " + TestWgCardNo + "\n" +
                   "已下发：3号楼门 M0041-1（" + controllerResults.Length.ToString(CultureInfo.InvariantCulture) + " 个控制器应答）\n" +
                   "26号楼失败路径：" + building26Result + "\n" +
                   "已移除：旧 26 号楼专用测试权限\n" +
                   "数据库备份：" + backupPath + "\n" +
                   "验收记录：" + reportPath;
        }

        private static int ReadOwnedPmsItemId(string databasePath)
        {
            using (var connection = Open(databasePath))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT TOP 1 EmpMemo FROM Employee WHERE vCardNo=?";
                command.Parameters.AddWithValue("@card", TestWgCardNo);
                var value = command.ExecuteScalar();
                var marker = value == null || value == DBNull.Value ? "" : Convert.ToString(value, CultureInfo.InvariantCulture);
                const string prefix = "PMS_ITEM_";
                int itemId;
                if (!marker.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
                    !Int32.TryParse(marker.Substring(prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out itemId))
                    throw new InvalidOperationException("测试卡 WG 22345575 不是 PMS 建立的测试记录，已停止下发，未修改数据");
                return itemId;
            }
        }

        private static string BackupDatabase(string source, string storeRoot)
        {
            var preferredRoot = Directory.Exists("D:\\") ? "D:\\PMS-Access-Backups" : Path.Combine(storeRoot, "backups");
            Directory.CreateDirectory(preferredRoot);
            var target = Path.Combine(preferredRoot, "MJDataBase-before-building3-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".mdb");
            File.Copy(source, target, false);
            if (!File.Exists(target) || new FileInfo(target).Length != new FileInfo(source).Length)
                throw new IOException("门禁数据库备份校验失败，已停止写入");
            return target;
        }

        private static void RemoveOldBuilding26TestRoutes(string databasePath, int itemId)
        {
            using (var connection = Open(databasePath))
            using (var transaction = connection.BeginTransaction())
            {
                try
                {
                    using (var ownership = connection.CreateCommand())
                    {
                        ownership.Transaction = transaction;
                        ownership.CommandText = "SELECT COUNT(*) FROM Employee WHERE vCardNo=? AND EmpMemo=?";
                        ownership.Parameters.AddWithValue("@card", TestWgCardNo);
                        ownership.Parameters.AddWithValue("@memo", "PMS_ITEM_" + itemId.ToString(CultureInfo.InvariantCulture));
                        if (Convert.ToInt32(ownership.ExecuteScalar(), CultureInfo.InvariantCulture) != 1)
                            throw new InvalidOperationException("测试卡归属校验失败，不移除旧权限");
                    }
                    foreach (var door in new[] { "M0038-1", "M0003-1", "M0030-1" })
                    {
                        using (var command = connection.CreateCommand())
                        {
                            command.Transaction = transaction;
                            command.CommandText = "DELETE FROM MJ_MacPower WHERE cCardNo=? AND cDoorId=?";
                            command.Parameters.AddWithValue("@card", TestWgCardNo);
                            command.Parameters.AddWithValue("@door", door);
                            command.ExecuteNonQuery();
                        }
                    }
                    transaction.Commit();
                }
                catch
                {
                    transaction.Rollback();
                    throw;
                }
            }
        }

        private static OleDbConnection Open(string databasePath)
        {
            var connection = new OleDbConnection(new OleDbConnectionStringBuilder
            {
                Provider = "Microsoft.Jet.OLEDB.4.0",
                DataSource = databasePath
            }.ConnectionString);
            connection.Open();
            return connection;
        }
    }
}
