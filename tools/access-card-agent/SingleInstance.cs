using System;
using System.Threading;

namespace Pms.AccessCardAgent
{
    /** 按 Windows 登录会话限制托盘和设置窗口只运行一份。 */
    internal static class SingleInstance
    {
        public static IDisposable TryEnter(string role)
        {
            bool created;
            var mutex = new Mutex(true, "Local\\PmsDataSyncAssistant." + role, out created);
            if (created) return new MutexLease(mutex);
            mutex.Dispose();
            return null;
        }

        private sealed class MutexLease : IDisposable
        {
            private Mutex _mutex;

            public MutexLease(Mutex mutex)
            {
                _mutex = mutex;
            }

            public void Dispose()
            {
                if (_mutex == null) return;
                try { _mutex.ReleaseMutex(); }
                catch (ApplicationException) { }
                _mutex.Dispose();
                _mutex = null;
            }
        }
    }
}
