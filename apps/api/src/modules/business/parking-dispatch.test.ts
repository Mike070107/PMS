import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { CronExpression } from '@nestjs/schedule';
import { BusinessExecutionService } from './business-execution.service';
import { entities, BusinessTransaction } from '../../entities';
import { BusinessServiceType } from '../../common/enums';
import { AccessCardIssuanceService } from '../access-card-issuance/access-card-issuance.service';
import { parkingReceiptCommitted, subscribeParkingReceipts } from '../access-card-issuance/parking-receipts';

async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities, synchronize: false });
  await (ds as any).buildMetadatas();
  (ds as any).isInitialized = true;
  ds.createQueryRunner = () => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: false, data: {},
      connect: async () => {}, release: async () => {},
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await pg.query(sql, params);
        if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr); return qr;
  };
  await pg.exec('CREATE TABLE business_transactions (id integer PRIMARY KEY, tenant_id integer, service_type varchar, external_sync_status varchar, snapshot jsonb, updated_at timestamp DEFAULT now())');
  const s: any = Object.create(BusinessExecutionService.prototype);
  s.txnRepo = ds.getRepository(BusinessTransaction); s.config = { get: () => 'on' };
  const runs: number[] = []; s.runOne = async (id: number) => { runs.push(id); };
  const insert = (id: number, tenant = 1, status = 'queued', execution: any = { steps: [{ operationId: 7 }] }, type = BusinessServiceType.PARKING_MONTHLY) => pg.query(
    'INSERT INTO business_transactions (id,tenant_id,service_type,external_sync_status,snapshot) VALUES ($1,$2,$3,$4,$5)', [id, tenant, type, status, JSON.stringify({ execution })]);
  return { s, pg, runs, insert };
}

test('停车执行兜底扫描每5秒一次，不再每分钟等下一阶段', () => {
  assert.equal(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', BusinessExecutionService.prototype.sweep)?.cronTime, CronExpression.EVERY_5_SECONDS);
});

test('真实SQL：回执只唤醒同租户、同任务、queued停车单；不重试人工/失败/已完成或retry单', async () => {
  const h = await fixture();
  try {
    await h.insert(1, 1, 'queued', { steps: [{ operationId: 7 }], nextAt: '2099-01-01T00:00:00Z' });
    await h.insert(2, 1, 'queued', { operationId: 7 });
    await h.insert(3, 2);
    for (const [i, status] of ['manual', 'failed', 'synced', 'retry', 'running'].entries()) await h.insert(4 + i, 1, status);
    await h.insert(9, 1, 'queued', { steps: [{ operationId: 8 }] });
    await h.insert(10, 1, 'queued', { registrationQueryId: 7 });
    await h.insert(11, 1, 'queued', { steps: [{ operationId: 7 }] }, 'other' as BusinessServiceType);
    await h.s.resumeAfterParkingReceipt({ tenantId: 1, kind: 'operation', id: 7 });
    assert.deepEqual(h.runs, [1, 2]);
    h.runs.length = 0;
    await h.s.resumeAfterParkingReceipt({ tenantId: 1, kind: 'query', id: 7 });
    assert.deepEqual(h.runs, [10]);
  } finally { await h.pg.close(); }
});

test('无效回执或关闭同步时不读取队列，也不执行', async () => {
  const s: any = Object.create(BusinessExecutionService.prototype);
  s.txnRepo = { createQueryBuilder: () => { throw Error('不应访问队列'); } };
  s.config = { get: () => 'on' };
  for (const receipt of [{ tenantId: 0, kind: 'operation', id: 7 }, { tenantId: 1, kind: 'operation', id: -7 }, { tenantId: 1, kind: 'operation', id: '7 OR 1=1' }, { tenantId: 1, kind: 'unknown', id: 7 }]) {
    await s.resumeAfterParkingReceipt(receipt);
  }
  s.config = { get: () => 'off' };
  await s.resumeAfterParkingReceipt({ tenantId: 1, kind: 'operation', id: 7 });
});

test('真实SQL：回执与扫描并发时仍只能原子领取一次，不重复执行登记', async () => {
  const h = await fixture();
  try {
    await h.insert(1);
    let executions = 0;
    h.s.txnRepo.findOneOrFail = async () => ({ snapshot: { parking: { newVehicle: true } } });
    h.s.runRegistration = async () => { executions++; };
    await Promise.all([BusinessExecutionService.prototype.runOne.call(h.s, 1), BusinessExecutionService.prototype.runOne.call(h.s, 1)]);
    assert.equal(executions, 1);
    const state = await h.pg.query<{ external_sync_status: string }>('SELECT external_sync_status FROM business_transactions WHERE id=1');
    assert.equal(state.rows[0].external_sync_status, 'running');
  } finally { await h.pg.close(); }
});

test('生命周期：重复初始化不重复订阅，销毁后不再推进；异步回执不阻塞报告', async () => {
  const s: any = Object.create(BusinessExecutionService.prototype);
  let runs = 0;
  s.logger = { log() {}, error() {} };
  s.resumeAfterParkingReceipt = async () => { runs++; };
  s.onModuleInit(); s.onModuleInit();
  try {
    parkingReceiptCommitted({ tenantId: 1, kind: 'operation', id: 7 });
    assert.equal(runs, 0);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
    s.onModuleDestroy();
    parkingReceiptCommitted({ tenantId: 1, kind: 'query', id: 8 });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
  } finally { s.onModuleDestroy(); }
});

test('真实SQL：选出queued后若状态转retry，回执领取不越过退避时间', async () => {
  const h = await fixture();
  try {
    await h.insert(1);
    h.s.txnRepo.findOneOrFail = async () => { throw Error('不应领取retry单'); };
    h.s.runOne = async (id: number, queuedOnly: boolean) => {
      assert.equal(queuedOnly, true);
      await h.pg.query("UPDATE business_transactions SET external_sync_status='retry' WHERE id=$1", [id]);
      await BusinessExecutionService.prototype.runOne.call(h.s, id, queuedOnly);
    };
    await h.s.resumeAfterParkingReceipt({ tenantId: 1, kind: 'operation', id: 7 });
    const state = await h.pg.query<{ external_sync_status: string }>('SELECT external_sync_status FROM business_transactions WHERE id=1');
    assert.equal(state.rows[0].external_sync_status, 'retry');
  } finally { await h.pg.close(); }
});

test('真实报告方法：仅事务成功提交后通知；写回滚不唤醒下一阶段', async () => {
  for (const kind of ['operation', 'query'] as const) {
    for (const rollback of [false, true]) {
      const s: any = Object.create(AccessCardIssuanceService.prototype);
      let committed = false;
      const received: any[] = [];
      const unsubscribe = subscribeParkingReceipts(receipt => { assert.equal(committed, true); received.push(receipt); });
      const task = { id: 7, tenantId: 1, status: 'running', leaseAgentKey: 'synthetic-agent', attempt: 1 };
      const repo = { findOne: async () => task, save: async () => { assert.equal(received.length, 0); } };
      const transaction = async (fn: any) => { await fn({ getRepository: () => repo }); if (rollback) throw Error('synthetic rollback'); committed = true; };
      s.authenticateAgent = async () => ({ kind: 'parking_gateway', tenantId: 1, agentKey: 'synthetic-agent' });
      s.parkingOperationRepo = s.parkingQueryRepo = { manager: { transaction } };
      try {
        const promise = kind === 'operation'
          ? s.reportParkingOperation('', '', { taskId: 7, result: 'failed', errorMessage: 'synthetic failure' })
          : s.reportParkingQuery('', '', { queryId: 7, result: 'failed', errorMessage: 'synthetic failure' });
        if (rollback) await assert.rejects(promise, /synthetic rollback/); else await promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(received, rollback ? [] : [{ tenantId: 1, kind, id: 7 }]);
      } finally { unsubscribe(); }
    }
  }
});
