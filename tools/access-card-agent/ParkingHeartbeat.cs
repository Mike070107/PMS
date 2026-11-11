using System;
using System.Diagnostics;
using System.Threading;

namespace Pms.AccessCardAgent
{
    // Parking only. Neither worker claims tasks or shares a database connection with the queue.
    internal sealed class ParkingHeartbeat : IDisposable
    {
        private readonly Func<bool> _probe;
        private readonly Action<bool> _heartbeat;
        private readonly Action<bool, string> _state;
        private readonly WaitHandle _externalStop;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly object _gate = new object();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly int _heartbeatMs;
        private readonly int _refreshMs;
        private readonly int _cacheMs;
        private Thread _heartbeatThread;
        private Thread _probeThread;
        private bool _started;
        private volatile bool _stopped;
        private bool _write;
        private long _validUntil;

        internal ParkingHeartbeat(Func<bool> probe, Action<bool> heartbeat, Action<bool, string> state,
            WaitHandle stop, int heartbeatMs, int refreshMs, int cacheMs)
        {
            if (probe == null || heartbeat == null) throw new ArgumentNullException();
            if (heartbeatMs <= 0 || refreshMs <= 0 || cacheMs <= 0) throw new ArgumentOutOfRangeException();
            _probe = probe;
            _heartbeat = heartbeat;
            _state = state;
            _externalStop = stop;
            _heartbeatMs = heartbeatMs;
            _refreshMs = refreshMs;
            _cacheMs = cacheMs;
        }

        internal bool CanWrite
        {
            get
            {
                lock (_gate) return !Stopping && _write && _clock.ElapsedMilliseconds < _validUntil;
            }
        }

        internal void Start()
        {
            lock (_gate)
            {
                if (_started || Stopping) return;
                _started = true;
                _heartbeatThread = new Thread(HeartbeatLoop) { IsBackground = true, Name = "PMS-parking-heartbeat" };
                _probeThread = new Thread(ProbeLoop) { IsBackground = true, Name = "PMS-parking-permissions" };
                _heartbeatThread.Start();
                _probeThread.Start();
            }
        }

        private bool Stopping
        {
            get { return _stopped || (_externalStop != null && _externalStop.WaitOne(0)); }
        }

        private bool Wait(int milliseconds)
        {
            if (_stopped) return true;
            if (_externalStop == null) return _stop.WaitOne(milliseconds);
            return WaitHandle.WaitAny(new[] { _stop, _externalStop }, milliseconds) != WaitHandle.WaitTimeout;
        }

        private void HeartbeatLoop()
        {
            while (!Wait(0))
            {
                var started = _clock.ElapsedMilliseconds;
                try
                {
                    _heartbeat(CanWrite);
                    PublishState(true, "PMS 心跳正常");
                }
                catch (Exception exception)
                {
                    PublishState(false, exception.Message);
                }
                // Send duration is part of the period; no SQL/task execution on this thread.
                var remaining = _heartbeatMs - (_clock.ElapsedMilliseconds - started);
                if (Wait((int)Math.Max(1, remaining))) break;
            }
        }

        private void ProbeLoop()
        {
            while (!Wait(0))
            {
                var started = _clock.ElapsedMilliseconds;
                var writable = false;
                try { writable = _probe(); }
                catch { /* Permission detection must never prevent a read-only heartbeat. */ }
                lock (_gate)
                {
                    if (Stopping) return;
                    // Bound freshness from probe START, not completion. A late successful result
                    // cannot resurrect old permissions; one thread means probes never overlap.
                    _validUntil = started + _cacheMs;
                    _write = writable && _clock.ElapsedMilliseconds < _validUntil;
                }
                if (Wait(_refreshMs)) break;
            }
        }

        private void PublishState(bool connected, string message)
        {
            lock (_gate)
            {
                if (Stopping || _state == null) return;
                try { _state(connected, message); }
                catch { /* A local status consumer must not terminate the heartbeat worker. */ }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (!_stopped)
                {
                    _stopped = true;
                    _write = false;
                    _stop.Set();
                }
            }
            // Do not abort SQL/HTTP threads or dispose handles they may still use. Existing
            // read-only probes may finish late; they cannot publish or start another probe.
            var heartbeatStopped = _heartbeatThread == null || _heartbeatThread.Join(1000);
            var probeStopped = _probeThread == null || _probeThread.Join(1000);
            if (heartbeatStopped && probeStopped) _stop.Close();
        }
    }
}
