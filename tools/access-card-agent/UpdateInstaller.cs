using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Pms.AccessCardAgent
{
    internal static class UpdateInstaller
    {
        public static void Apply(string targetExecutable, int previousProcessId)
        {
            targetExecutable = Path.GetFullPath(targetExecutable);
            var targetDirectory = Path.GetDirectoryName(targetExecutable);
            var configPath = Path.Combine(targetDirectory, "agent.config.json");
            var config = AgentConfig.Load(configPath);
            var serviceName = WindowsServiceInstaller.ServiceName(config);

            try
            {
                if (previousProcessId > 0)
                {
                    var previous = Process.GetProcessById(previousProcessId);
                    previous.WaitForExit(15000);
                }
            }
            catch (ArgumentException) { }

            var restartService = WindowsServiceInstaller.StopForUpdate(serviceName);
            var backup = targetExecutable + ".previous";
            File.Copy(targetExecutable, backup, true);
            File.Copy(Process.GetCurrentProcess().MainModule.FileName, targetExecutable, true);
            if (restartService) WindowsServiceInstaller.StartAfterUpdate(serviceName);
            Process.Start(new ProcessStartInfo { FileName = targetExecutable, UseShellExecute = true });
            MessageBox.Show(
                "更新完成。代理身份、连接密钥和数据库密码均已保留。\n旧程序备份：" + Path.GetFileName(backup),
                "PMS 数据同步助手", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
