using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Pms.LanGatewayAssistant
{
    internal sealed class GatewayRuntime : IDisposable
    {
        private readonly GatewayConfigurationStore _store;
        private readonly ManualResetEvent _stopping = new ManualResetEvent(false);
        private Process _process;
        private Thread _thread;
        public GatewayRuntime(GatewayConfigurationStore store) { _store = store; }
        public void Start() { _thread = new Thread(Run) { IsBackground = true, Name = "PMS LAN gateway supervisor" }; _thread.Start(); }
        public void Stop() { _stopping.Set(); StopChild(); if (_thread != null) _thread.Join(10000); }
        private void Run()
        {
            while (!_stopping.WaitOne(0))
            {
                try
                {
                    var configuration = _store.Load();
                    _store.WriteRuntimeToken();
                    File.WriteAllText(_store.FrpcConfigPath, FrpConfiguration.Build(configuration, _store), new UTF8Encoding(false));
                    if (!File.Exists(_store.FrpcPath)) throw new FileNotFoundException("代理核心 frpc.exe 未安装", _store.FrpcPath);
                    _process = Process.Start(new ProcessStartInfo { FileName = _store.FrpcPath, Arguments = "-c \"" + _store.FrpcConfigPath + "\"", WorkingDirectory = _store.RootPath, UseShellExecute = false, CreateNoWindow = true });
                    WriteHealth(true, "代理核心运行中", _process.Id);
                    while (!_stopping.WaitOne(1000) && !_process.HasExited) { }
                    if (_stopping.WaitOne(0)) break;
                    WriteHealth(false, "代理核心已退出，1 分钟后自动重试", 0);
                }
                catch (Exception exception) { WriteHealth(false, exception.Message, 0); }
                finally { StopChild(); }
                if (_stopping.WaitOne(TimeSpan.FromMinutes(1))) break;
            }
            WriteHealth(false, "后台服务已停止", 0);
        }
        private void StopChild() { try { if (_process != null && !_process.HasExited) { _process.Kill(); _process.WaitForExit(5000); } } catch { } finally { if (_process != null) _process.Dispose(); _process = null; } }
        private void WriteHealth(bool running, string message, int processId)
        {
            try
            {
                var value = new GatewayHealth { CheckedAt = DateTimeOffset.Now.ToString("o"), ProcessRunning = running, Message = message, ProcessId = processId };
                var json = new JavaScriptSerializer().Serialize(value); var temporary = _store.HealthPath + ".new"; File.WriteAllText(temporary, json, new UTF8Encoding(false));
                if (File.Exists(_store.HealthPath)) File.Replace(temporary, _store.HealthPath, _store.HealthPath + ".previous", true); else File.Move(temporary, _store.HealthPath);
            }
            catch { }
        }
        public void Dispose() { Stop(); _stopping.Dispose(); }
    }
}
