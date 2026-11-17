const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { executeOnce, flushJournal, storeFor, run, transport } = require('./runner.cjs');
const { createAdapter } = require('./sqlite-readonly.example.cjs');
const root = path.resolve(__dirname, '../../outputs/omission-release-20261117/standard/adapter-tests', String(Date.now()));
function store(name) { return storeFor(path.join(root, name), 'local-synthetic'); }
function task(id = 1, operation = 'access.query') { return { id, operation, revision: 1, resourceId: 'site.main', idempotencyKey: 'synthetic-' + id, leaseToken: 'SYNTHETIC-LEASE', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), command: { query: { field: 'card', value: '123' } } }; }
test('real SQLite mapping reads only configured schema, binds values and withdraws readiness on missing DB', async () => {
  fs.mkdirSync(root, { recursive: true }); const file = path.join(root, 'readonly.sqlite'); const db = new DatabaseSync(file);
  db.exec("CREATE TABLE PermitCards(CardNo TEXT, HolderName TEXT, Room TEXT, Enabled INTEGER); INSERT INTO PermitCards VALUES('123','合成住户','1/101',1)"); db.close();
  const adapter = createAdapter({ databasePath: file }); assert.equal((await adapter.ready()).length, 1);
  const input = { ...task(), signal: new AbortController().signal, deadline: task().leaseExpiresAt };
  assert.deepEqual((await adapter.execute(input)).records, [{ cardNumber: '123', name: '合成住户', room: '1/101', status: 'active' }]);
  input.command.query.value = "' OR 1=1 --"; assert.deepEqual((await adapter.execute(input)).records, []);
  assert.equal((await adapter.execute({ ...input, operation: 'access.grant' })).code, 'UNSUPPORTED_OPERATION');
  assert.deepEqual(await createAdapter({ databasePath: path.join(root, 'missing.sqlite') }).ready(), []);
});
test('lost report retries original durable receipt without re-executing; completed old task remains deduplicated', async () => {
  const journal = store('report-loss'); let writes = 0, reports = 0;
  const adapter = { execute: async () => { writes++; return { outcome: 'succeeded', evidence: 'database_readback' }; } };
  const post = async () => { if (++reports === 1) throw Error('synthetic connection loss'); };
  await assert.rejects(executeOnce(task(1, 'access.grant'), adapter, journal, post));
  assert.equal(journal.read().phase, 'result');
  await executeOnce(task(1, 'access.grant'), adapter, journal, post); assert.equal(writes, 1);
  await executeOnce(task(2, 'access.grant'), adapter, journal, post); assert.equal(writes, 2);
  await executeOnce(task(1, 'access.grant'), adapter, journal, post); assert.equal(writes, 2);
});
test('interrupted durable intent reconciles as unknown; invalid success evidence is not accepted', async () => {
  const journal = store('crash'); journal.save({ taskId: 7, leaseToken: 'SYNTHETIC', phase: 'executing' }); let received;
  await flushJournal(journal, async (_route, body) => { received = body; }); assert.equal(received.result.outcome, 'unknown');
  let executed = false; await executeOnce(task(7), { execute: async () => { executed = true; } }, journal, async () => {}); assert.equal(executed, false);
  await executeOnce(task(8, 'card.write'), { execute: async () => ({ outcome: 'succeeded', evidence: 'database_readback' }) }, journal, async (_route, body) => { received = body; });
  assert.equal(received.result.outcome, 'unknown');
});
test('expired leases never execute and transport refuses plaintext non-local URLs', async () => {
  let executed = false; await assert.rejects(executeOnce({ ...task(), leaseExpiresAt: '2020-01-01T00:00:00Z' }, { execute: () => { executed = true; } }, store('expired'), async () => {})); assert.equal(executed, false);
  assert.throws(() => transport('http://example.com/api/v1', 'key', 'SYNTHETIC'), /HTTPS/);
  assert.throws(() => transport('https://user:password@example.com/api/v1', 'key', 'SYNTHETIC'), /Invalid base/);
});
test('runner heartbeats real readiness, claims and reports, exits cleanly, excludes a second runner', async () => {
  const abort = new AbortController(); const directory = path.join(root, 'loop'); let executions = 0, claimed = false; const events = [];
  const adapter = { ready: async () => [{ id: 'site.main', label: '合成资源', capabilities: [{ operation: 'access.query', revision: 1 }] }], execute: async () => { executions++; return { outcome: 'succeeded', evidence: 'observed' }; } };
  await run({ adapter, directory, integrationKey: 'local-synthetic', signal: abort.signal, pollMs: 1, log: () => {}, post: async (route, body) => {
    events.push(route); if (route === 'heartbeat') { assert.equal(body.ready[0].id, 'site.main'); }
    if (route === 'claim') { if (claimed) return { task: null }; claimed = true;
      await assert.rejects(run({ adapter, directory, integrationKey: 'local-synthetic', signal: abort.signal, post: async () => {} }), /lock exists/);
      return { task: task() }; }
    if (route.endsWith('/report')) { assert.equal(body.result.evidence, 'observed'); abort.abort(); }
    return {};
  } });
  assert.equal(executions, 1); assert.deepEqual(events, ['heartbeat', 'claim', 'tasks/1/report']); assert.equal(fs.existsSync(path.join(directory, 'runner.lock')), false);
});
