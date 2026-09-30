using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.IO;
using System.Linq;

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
                return TestFiles(item);
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

        private static ConnectionTestResult TestFiles(ConnectionConfiguration item)
        {
            var path = Get(item, "path");
            if (String.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("数据库文件路径为空");
            var result = new ConnectionTestResult();
            if (File.Exists(path)) result.Checks.Add(Path.GetFileName(path) + " 文件存在");
            else if (Directory.Exists(path))
            {
                var files = Directory.GetFiles(path, "*.mdb", SearchOption.TopDirectoryOnly);
                if (files.Length == 0) throw new InvalidOperationException("指定目录中没有找到 MDB 数据库文件");
                result.Checks.Add("找到 " + files.Length + " 个 MDB 数据库文件");
            }
            else throw new InvalidOperationException("数据库文件或目录不存在：" + path);
            result.Success = true;
            result.Summary = String.Join("；", result.Checks.ToArray());
            return result;
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
