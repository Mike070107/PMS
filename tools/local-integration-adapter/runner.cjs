'use strict';
// Vendor-independent protocol runner. All database/SDK access belongs in the supplied adapter.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const EVIDENCE = { 'card.inspect': 'observed', 'card.write': 'card_readback', 'access.query': 'observed', 'access.grant': 'database_readback', 'access.revoke': 'database_readback', 'access.controller.apply': 'controller_ack', 'parking.query': 'observed', 'parking.vehicle.upsert': 'database_readback', 'parking.vehicle.renew': 'database_readback' };
function validateResult(operation, result) {
  if (!result || !['succeeded', 'failed', 'unknown'].includes(result.outcome)) throw Error('Invalid adapter outcome');
  if (Object.keys(result).some(k => !['outcome', 'evidence', 'code', 'message', 'records'].includes(k))) throw Error('Nonstandard adapter result');
  if (result.outcome === 'succeeded' && result.evidence !== EVIDENCE[operation]) throw Error('Missing verified readback/acknowledgement');
  return result;
}
function storeFor(directory, integrationKey) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'journal.json');
  const receipts = path.join(directory, 'receipts');
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  return {
    readReceipt(taskId) {
      if (!/^\d+$/.test(String(taskId))) throw Error('Invalid task id');
      const receipt = path.join(receipts, String(taskId) + '.json');
      return fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null;
    },
    read() {
      if (!fs.existsSync(file)) return null;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.integrationKey !== integrationKey) throw Error('Journal belongs to another connection; use a separate state directory');
      return value;
    },
    save(value) {
      const temporary = file + '.new';
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ ...value, integrationKey }), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      if (value.phase === 'reported') {
        if (!/^\d+$/.test(String(value.taskId))) throw Error('Invalid task id');
        const receipt = path.join(receipts, String(value.taskId) + '.json');
        const fd = fs.openSync(receipt, 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ taskId: value.taskId, integrationKey, phase: 'reported' })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    },
  };
}
async function flushJournal(store, post) {
  let record = store.read();
  if (!record) return;
  if (record.phase === 'reported') { if (!store.readReceipt(record.taskId)) store.save(record); return; }
  if (record.phase === 'executing') {
    record = { ...record, phase: 'result', result: { outcome: 'unknown', code: 'PROCESS_INTERRUPTED', message: '执行进程中断；必须人工核对，不会自动再次执行' } };
    store.save(record);
  }
  await post(`tasks/${record.taskId}/report`, { leaseToken: record.leaseToken, result: record.result });
  store.save({ ...record, phase: 'reported' });
}
async function executeOnce(task, adapter, store, post, now = () => Date.now()) {
  await flushJournal(store, post);
  const previous = store.read();
  if (store.readReceipt(task.id) || (previous && String(previous.taskId) === String(task.id))) return; // never repeat a claimed physical task
  const leaseEnd = Date.parse(task.leaseExpiresAt);
  if (!Number.isFinite(leaseEnd) || leaseEnd <= now() || !EVIDENCE[task.operation] || task.revision !== 1 || !task.leaseToken) throw Error('Unsupported/expired task envelope');
  const record = { taskId: task.id, leaseToken: task.leaseToken, phase: 'executing' };
  // The durable intent MUST precede the first external side effect. Never persist business data or vendor credentials.
  store.save(record);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1, leaseEnd - now() - 5000));
  let result;
  try {
    result = validateResult(task.operation, await adapter.execute({ operation: task.operation, revision: task.revision, resourceId: task.resourceId, command: task.command, taskId: String(task.id), idempotencyKey: task.idempotencyKey, deadline: task.leaseExpiresAt, signal: abort.signal }));
  } catch {
    // A thrown error may follow a successful physical/database write. Do not invent a safe failure or retry.
    result = { outcome: 'unknown', code: 'ADAPTER_UNCERTAIN', message: '适配器未能提供可验证结果；请人工核对原任务，不会自动重做' };
  } finally { clearTimeout(timer); }
  store.save({ ...record, phase: 'result', result });
  await flushJournal(store, post);
}
function acquireLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'runner.lock');
  try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Never auto-remove even a stale PID lock: PID reuse and two simultaneous recoveries can permit duplicate physical execution.
    throw Error('Adapter lock exists; verify every old runner has exited before manually removing runner.lock. Preserve journal.json for reconciliation.');
  }
  return () => { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}
function transport(baseUrl, key, token) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw Error('HTTPS required outside explicit localhost tests');
  if (base.username || base.password || base.search || base.hash) throw Error('Invalid base URL');
  const prefix = base.href.replace(/\/$/, '') + `/local-integration-agent/v1/${encodeURIComponent(key)}/`;
  return async (route, body) => {
    const response = await fetch(prefix + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Error(`PMS HTTP ${response.status}`); // Never echo response bodies, tokens, SQL or vendor errors into a log.
    return response.json();
  };
}
async function run({ adapter, post, directory, integrationKey, signal, log = console.log, pollMs = 2500 }) {
  if (!adapter || typeof adapter.ready !== 'function' || typeof adapter.execute !== 'function') throw Error('Adapter must implement ready() and execute()');
  const release = acquireLock(directory); const store = storeFor(directory, integrationKey);
  let fresh = false, heartbeatBusy = false;
  const heartbeat = async () => {
    if (heartbeatBusy || signal.aborted) return;
    heartbeatBusy = true;
    try {
      let ready = []; try { ready = await adapter.ready(); } catch { /* Explicitly withdraw readiness on probe failure. */ }
      await post('heartbeat', { protocolVersion: '1.0', version: adapter.version || '1.0.0', ready });
      fresh = !signal.aborted;
    } catch { fresh = false; log('PMS heartbeat unavailable; task intake paused'); }
    finally { heartbeatBusy = false; }
  };
  const delay = () => new Promise(resolve => { if (signal.aborted) return resolve(); const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, pollMs); signal.addEventListener('abort', finish, { once: true }); });
  let interval;
  try {
    await heartbeat(); interval = setInterval(heartbeat, 5000);
    while (!signal.aborted) {
      try {
        // Result retry is separate from execution: no receipt never means execute again.
        await flushJournal(store, post);
        if (fresh && !signal.aborted) { const response = await post('claim', {}); if (response.task) await executeOnce(response.task, adapter, store, post); }
      } catch { log('PMS task/receipt unavailable; original task retained, no automatic re-execution'); }
      await delay();
    }
  } finally {
    clearInterval(interval);
    // Never release the single-runner lock while an asynchronous heartbeat is still in flight.
    while (heartbeatBusy) await new Promise(resolve => setTimeout(resolve, 20));
    release();
  }
}
module.exports = { run, executeOnce, flushJournal, storeFor, transport, validateResult };
if (require.main === module) {
  (async () => {
    const token = process.env.PMS_LOCAL_INTEGRATION_TOKEN || '';
    const match = /^(local-[a-f0-9]{32})\.(.+)$/.exec(token);
    if (!match || !process.argv[2] || !process.argv[3] || !process.env.PMS_API_BASE_URL) throw Error('Set PMS_API_BASE_URL and PMS_LOCAL_INTEGRATION_TOKEN; provide adapter module and private state directory');
    const imported = await import(pathToFileURL(path.resolve(process.argv[2])).href);
    const adapter = imported.default || imported;
    const abort = new AbortController(); process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
    await run({ adapter, post: transport(process.env.PMS_API_BASE_URL, match[1], token), directory: path.resolve(process.argv[3]), integrationKey: match[1], signal: abort.signal });
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
