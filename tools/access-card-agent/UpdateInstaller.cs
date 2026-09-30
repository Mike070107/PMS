using System;
using System.Diagnostics;
using System.IO;

namespace Pms.AccessCardAgent
{
    internal static class UpdateInstaller
    {
        public static void Apply(string targetExecutable, int previousProcessId)
        {
            targetExecutable = Path.GetFullPath(targetExecutable);
            var targetDirectory = Path.GetDirectoryName(targetExecutable);
            var configPath = Path.Combine(targetDirectory, "agent.config.json");
            var progressPath = Path.Combine(targetDirectory, "update-progress.txt");
            WriteProgress(progressPath, "正在读取现有配置");
            var config = AgentConfig.Load(configPath);
            var serviceName = WindowsServiceInstaller.ServiceName(config);

            try
            {
                if (previousProcessId > 0)
                {
                    var previous = Process.GetProcessById(previousProcessId);
                    WriteProgress(progressPath, "正在关闭旧设置窗口");
                    if (!previous.WaitForExit(5000))
                        throw new InvalidOperationException("旧设置窗口没有正常退出，请关闭窗口后重试");
                }
            }
            catch (ArgumentException) { }

            WriteProgress(progressPath, "正在停止后台服务");
            var restartService = WindowsServiceInstaller.StopForUpdate(serviceName);
            var backup = targetExecutable + ".previous";
            WriteProgress(progressPath, "正在备份和替换程序");
            File.Copy(targetExecutable, backup, true);
            File.Copy(Process.GetCurrentProcess().MainModule.FileName, targetExecutable, true);
            if (restartService)
            {
                WriteProgress(progressPath, "正在重新启动后台服务");
                WindowsServiceInstaller.StartAfterUpdate(serviceName);
            }
            WriteProgress(progressPath, "更新完成");
            Process.Start(new ProcessStartInfo { FileName = targetExecutable, Arguments = "--updated", UseShellExecute = true });
        }

        private static void WriteProgress(string path, string message)
        {
            File.WriteAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message);
        }
    }
}
