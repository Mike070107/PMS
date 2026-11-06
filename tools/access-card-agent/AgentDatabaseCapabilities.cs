using System;
using System.Data.OleDb;
using System.IO;

namespace Pms.AccessCardAgent
{
    internal sealed class AccessDatabaseCapability
    {
        public bool mjSystemReadable { get; set; }
        public bool mjSystemWritable { get; set; }
        public bool icCardReadable { get; set; }
        public bool icCardWritable { get; set; }
        public bool controllerUpload { get; set; }
        public string mjSystemPath { get; set; }
        public string icCardPath { get; set; }
        public string mjSystemMessage { get; set; }
        public string icCardMessage { get; set; }

        public bool CanWrite
        {
            get { return mjSystemWritable || icCardWritable; }
        }

        public bool CanRead
        {
            get { return mjSystemReadable || icCardReadable; }
        }
    }

    /**
     * 如实探测 .88 两套 MDB 的读/写能力，不再只凭代理身份把 accessDbWrite 写死为 true。
     * 写探测使用「零行受影响」的 UPDATE + 回滚事务：只验证数据库/文件写权限，不修改任何业务数据。
     */
    internal static class AccessDatabaseCapabilityProbe
    {
        public static AccessDatabaseCapability Probe(AgentConfig config, string password)
        {
            var result = new AccessDatabaseCapability
            {
                mjSystemPath = config == null ? null : config.MjSystemDatabasePath,
                icCardPath = config == null ? null : config.IcCardDatabasePath,
                controllerUpload = config != null && AccessControllerUploader.CanUpload(config)
            };
            ProbeMjSystem(config, result);
            ProbeIcCard(config, password, result);
            return result;
        }

        private static void ProbeMjSystem(AgentConfig config, AccessDatabaseCapability result)
        {
            try
            {
                using (var connection = Open(config.MjSystemDatabasePath, null, "MjSystem"))
                {
                    result.mjSystemReadable = true;
                    using (var transaction = connection.BeginTransaction())
                    {
                        try
                        {
                            using (var command = connection.CreateCommand())
                            {
                                command.Transaction = transaction;
                                command.CommandText = "UPDATE Employee SET EmpMemo=EmpMemo WHERE EId=-1";
                                command.ExecuteNonQuery();
                            }
                            result.mjSystemWritable = true;
                            result.mjSystemMessage = "只读和写权限均已验证（零行 UPDATE + 回滚）";
                            transaction.Rollback();
                        }
                        catch (Exception exception)
                        {
                            result.mjSystemWritable = false;
                            result.mjSystemMessage = "可读，但 MDB 写权限验证失败：" + exception.Message;
                            try { transaction.Rollback(); } catch { }
                        }
                    }
                }
            }
            catch (Exception exception)
            {
                result.mjSystemReadable = false;
                result.mjSystemWritable = false;
                result.mjSystemMessage = "打开 MjSystem 失败：" + exception.Message;
            }
        }

        private static void ProbeIcCard(AgentConfig config, string password, AccessDatabaseCapability result)
        {
            try
            {
                using (var connection = Open(config.IcCardDatabasePath, password, "iCCard"))
                {
                    result.icCardReadable = true;
                    using (var transaction = connection.BeginTransaction())
                    {
                        try
                        {
                            using (var command = connection.CreateCommand())
                            {
                                command.Transaction = transaction;
                                command.CommandText = "UPDATE t_b_IDCard SET f_CardStatusDesc=f_CardStatusDesc WHERE f_CardID=-1";
                                command.ExecuteNonQuery();
                            }
                            result.icCardWritable = true;
                            result.icCardMessage = "只读和写权限均已验证（零行 UPDATE + 回滚）";
                            transaction.Rollback();
                        }
                        catch (Exception exception)
                        {
                            result.icCardWritable = false;
                            result.icCardMessage = "可读，但 iCCard 写权限验证失败：" + exception.Message;
                            try { transaction.Rollback(); } catch { }
                        }
                    }
                }
            }
            catch (Exception exception)
            {
                result.icCardReadable = false;
                result.icCardWritable = false;
                result.icCardMessage = String.IsNullOrEmpty(password)
                    ? "打开 iCCard 失败（未安装 MDB 密码）：" + exception.Message
                    : "打开 iCCard 失败：" + exception.Message;
            }
        }

        private static OleDbConnection Open(string path, string password, string name)
        {
            return AccessOleDb.Open(path, password, name);
        }
    }
}
