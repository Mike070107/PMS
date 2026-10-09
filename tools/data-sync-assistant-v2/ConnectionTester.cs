using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.IO;
using System.Linq;
using Pms.AccessCardAgent;

namespace Pms.DataSyncAssistant
{
    public sealed class ConnectionTestResult
    {
        public bool Success { get; set; }
        public string Summary { get; set; }
        public List<string> Checks { get; private set; }
        public ConnectionTestResult() { Checks = new List<string>(); }
    }

    public static class ConnectionTester
    {
        public static ConnectionTestResult Test(ConnectionConfiguration item, string password)
        {
            if (item.Type == ConnectionTypes.Parking || item.Type == ConnectionTypes.LegacyAccess)
                return TestSql(item, password);
            if (item.Type == ConnectionTypes.BuildingAccess)
                return TestAccessDatabases(item, password);
            if (item.Type == ConnectionTypes.CardReader)
                return TestReader();
            throw new InvalidOperationException("尚不支持这种连接类型");
        }

        private static ConnectionTestResult TestSql(ConnectionConfiguration item, string password)
        {
            var server = Get(item, "server");
            var user = Get(item, "user");
            if (String.IsNullOrWhiteSpace(server)) throw new InvalidOperationException("SQL Server 地址为空");
            if (String.IsNullOrWhiteSpace(user)) throw new InvalidOperationException("数据库用户为空");
            if (String.IsNullOrWhiteSpace(password)) throw new InvalidOperationException("数据库密码尚未保存，请输入密码");
            var databases = new[] { Get(item, "database1"), Get(item, "database2") }.Where(value => !String.IsNullOrWhiteSpace(value)).ToArray();
            if (databases.Length == 0) throw new InvalidOperationException("至少填写一个数据库名称");
            var result = new ConnectionTestResult();
            foreach (var database in databases)
            {
                var builder = new SqlConnectionStringBuilder
                {
                    DataSource = server,
                    InitialCatalog = database,
                    UserID = user,
                    Password = password,
                    ConnectTimeout = 4,
                    Encrypt = false,
                    IntegratedSecurity = false
                };
                try
                {
                    using (var connection = new SqlConnection(builder.ConnectionString))
                    using (var command = new SqlCommand("SELECT 1", connection))
                    {
                        connection.Open();
                        command.CommandTimeout = 4;
                        command.ExecuteScalar();
                    }
                    result.Checks.Add(database + " 可以连接并读取");
                }
                catch (Exception exception)
                {
                    throw new InvalidOperationException(database + " 连接失败：" + FriendlySqlError(exception));
                }
            }
            result.Success = true;
            result.Summary = String.Join("；", result.Checks.ToArray());
            return result;
        }

        public static void TestParkingMovements(ConnectionConfiguration item, string password, string movementPassword,
            ConnectionTestResult result)
        {
            var config = ConnectionAgentRuntime.BuildAgentConfig(item, new HostConfiguration());
            var today = DateTime.Today.ToString("yyyy-MM-dd");
            try
            {
                // 只读、精确车牌、当日范围；即使没有匹配记录也能验证两期 Car_Out 的表与字段。
                ParkingDatabase.SearchMovementsBoth(config, password, movementPassword, "沪A00000", today, today);
                result.Checks.Add("一期、二期停车库 Car_Out 进出记录可读");
                result.Summary = String.Join("；", result.Checks.ToArray());
            }
            catch (Exception exception)
            {
                throw new InvalidOperationException("停车库进出记录检测失败：" + FriendlySqlError(exception));
            }
        }

        private static ConnectionTestResult TestAccessDatabases(ConnectionConfiguration item, string password)
        {
            var config = ConnectionAgentRuntime.BuildAgentConfig(item, new HostConfiguration());
            var result = new ConnectionTestResult();
            var mj = AccessGatewayDatabase.ProbeMjSystem(config);
            result.Checks.Add("MjSystem 已读取：" + SummarizeCounts(mj.Counts));
            var ic = AccessGatewayDatabase.ProbeIcCard(config, password);
            result.Checks.Add("iCCard 已读取：" + SummarizeCounts(ic.Counts));
            result.Success = true;
            result.Summary = String.Join("；", result.Checks.ToArray());
            return result;
        }

        private static string SummarizeCounts(Dictionary<string, int> counts)
        {
            return String.Join("，", counts.Select(value => value.Key + " " + value.Value).ToArray());
        }

        private static ConnectionTestResult TestReader()
        {
            var readers = Pms.AccessCardAgent.CardReader.ListReaders();
            if (readers.Length == 0) throw new InvalidOperationException("未检测到 PC/SC 发卡器，请检查 USB 和驱动");
            return new ConnectionTestResult
            {
                Success = true,
                Summary = "检测到 " + readers.Length + " 个发卡器",
            }.WithChecks(readers);
        }

        private static ConnectionTestResult WithChecks(this ConnectionTestResult result, IEnumerable<string> values)
        {
            result.Checks.AddRange(values.Select(value => "已识别 " + value));
            return result;
        }

        private static string FriendlySqlError(Exception exception)
        {
            var sql = exception as SqlException;
            if (sql != null)
            {
                if (sql.Number == 18456) return "数据库用户名或密码不正确";
                if (sql.Number == 4060) return "数据库名称不存在或账号无权访问";
                if (sql.Number == -2) return "连接超时，请检查服务器地址和网络";
            }
            return exception.Message;
        }

        private static string Get(ConnectionConfiguration item, string key)
        {
            string value; return item.Parameters.TryGetValue(key, out value) ? value : "";
        }
    }
}
