using System;
using System.Collections.Generic;
using System.Data.OleDb;
using System.IO;

namespace Pms.AccessCardAgent
{
    /**
     * 统一的 Access 连接入口：优先 Jet 4.0，失败再试 ACE OLEDB 12.0。
     * .88 现场原软件使用 Jet；部分新 Windows 只装了 ACE（Office 自带），
     * 本地备份验证也可能只有其中之一。数据库密码只从调用方传入，不写日志。
     */
    internal static class AccessOleDb
    {
        private static readonly string[] Providers = new[]
        {
            "Microsoft.Jet.OLEDB.4.0",
            "Microsoft.ACE.OLEDB.12.0"
        };

        public static OleDbConnection Open(string path, string password, string name)
        {
            if (String.IsNullOrWhiteSpace(path))
                throw new InvalidOperationException(name + " 数据库路径未配置");
            if (!File.Exists(path))
                throw new FileNotFoundException(name + " 数据库不存在", path);
            var errors = new List<string>();
            foreach (var provider in Providers)
            {
                try
                {
                    var builder = new OleDbConnectionStringBuilder { Provider = provider, DataSource = path };
                    if (!String.IsNullOrEmpty(password)) builder["Jet OLEDB:Database Password"] = password;
                    var connection = new OleDbConnection(builder.ConnectionString);
                    connection.Open();
                    return connection;
                }
                catch (Exception exception)
                {
                    errors.Add(provider + "：" + exception.Message +
                        "（" + exception.GetType().Name + " HR=0x" + exception.HResult.ToString("X8") + "）");
                }
            }
            throw new InvalidOperationException(
                "打开 " + name + " 失败（进程位数 " + (IntPtr.Size == 4 ? "x86" : "x64") + "；" +
                String.Join("；", errors.ToArray()) +
                "）。请确认该电脑已安装 Microsoft Jet 4.0 或 ACE OLEDB 12.0 驱动。");
        }
    }
}
