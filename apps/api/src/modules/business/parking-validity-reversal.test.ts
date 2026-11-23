import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { BusinessExecutionService } from './business-execution.service';
import { hasLaterParkingPayment, planVerifiedParkingReversal } from './parking-validity-reversal';
import type { BusinessTransaction, ParkingOperation } from '../../entities';

const plate = '沪T12345';
function fixture() {
  const original = { id: 7, tenantId: 1, txnNo: 'PK7', endDate: '2027-04-30', snapshot: { reversedByTxnNo: 'PKR-7',
    execution: { steps: [
      { key: 'local:parking2:42', label: '二期', kind: 'local', status: 'done', operationId: 21 },
      { key: 'deliyun:枫桦景苑', label: '人防', kind: 'deliyun', status: 'done', operationId: 22 },
    ] } } } as unknown as BusinessTransaction;
  const reversal = { id: 8, tenantId: 1, txnNo: 'PKR-7', targetId: 7, snapshot: { reversal: { reviewValidity: true } }, createdBy: 1 };
  const local = { id: 21, tenantId: 1, status: 'completed', kind: 'renew_vehicle', database: 'parking2', sourceRecordId: '42',
    payload: { businessTxnNo: 'PK7', plate, endDate: '2027-04-30' },
    result: { verified: true, plate, issueId: 42, previousEndDate: '2026-11-30', endDate: '2027-04-30', startDate: '2026-01-01', previousStartDate: '2026-01-01', legacyAuditId: '99', legacyAuditVerified: true } } as unknown as ParkingOperation;
  const cloud = { id: 22, tenantId: 1, status: 'completed', kind: 'renew_vehicle', database: 'deliyun', sourceRecordId: 'cloud-v1',
    payload: { businessTxnNo: 'PK7', plate, endDate: '2027-04-30', park: '枫桦景苑' },
    result: { verified: true, plate, vehicleId: 'cloud-v1', previousEndDate: '2026-12-31', endDate: '2027-04-30' } } as unknown as ParkingOperation;
  const jobs: any[] = [];
  const writes: any[] = [];
  const scenario = { later: false, cloudChanged: false };
  const service: any = Object.create(BusinessExecutionService.prototype);
  const repo = {
    findOne: async ({where}:any) => [local,cloud].find(r=>r.id===where.id) ?? jobs.find(r=>r.idempotencyKey===where.idempotencyKey),
    create: (row:any)=>row,
    save: async (row:any)=>{ const saved = {...row, id: jobs.length+50}; jobs.push(saved); return saved; },
  };
  service.txnRepo = { findOne: async()=>original };
  service.opRepo = { ...repo, manager:{ transaction:async (run:any)=>run({
    query:async (sql:string)=>sql.includes('business_transactions')&&scenario.later?[{}]:[], getRepository:()=>repo,
  }) } };
  service.deliyun = { renewVehicle: async (args:any)=>{
    if(scenario.cloudChanged) throw Error('德立云当前到期日已变化，请核对');
    writes.push(args); return {verified:true,endDate:args.endDate};
  } };
  service.finish = async (_txn:any,status:string,state:any)=>({status,state});
  return {local,cloud,original,jobs,writes,scenario,run:(state={},mode='on')=>service.runValidityReversal(reversal,state,mode,1,plate)};
}

test('红冲逐库回退真实旧到期日，复用任务并等现场读回', async () => {
  const f=fixture();
  const first=await f.run();
  assert.equal(first.status,'queued'); assert.equal(f.jobs.length,2);
  assert.equal(f.jobs[0].rollbackOfOperationId,21);
  assert.equal(f.jobs[0].payload.endDate,'2026-11-30');
  assert.equal(f.jobs[0].expected.validityReversal.legacyAuditId,'99');
  assert.equal(f.jobs[0].payload.amount,undefined);
  assert.deepEqual(f.writes,[{vehicleId:'cloud-v1',plate,previousEndDate:'2027-04-30',endDate:'2026-12-31',customEndDate:true,parkName:'枫桦景苑'}]);
  f.jobs[0].status='completed'; f.jobs[0].result={verified:true,endDate:'2026-11-30'};
  const second=await f.run(first.state); assert.equal(second.status,'synced');
  assert.equal(f.jobs.length,2); assert.equal(f.writes.length,1);
  assert.match(second.state.steps[0].note,/2026-11-30.*已回读/);
});

test('日期原先没变时跳过；后续收费、现场变化、缺回执均转人工', async () => {
  const same=fixture(); same.local.result!.previousEndDate='2027-04-30'; same.cloud.result!.previousEndDate='2027-04-30';
  assert.equal((await same.run()).status,'synced'); assert.equal(same.jobs.length,0);
  const later=fixture(); later.scenario.later=true;
  assert.match((await later.run()).state.lastError,/后续有效停车收款/); assert.equal(later.jobs.length,0);
  const stale=fixture(); stale.scenario.cloudChanged=true; stale.local.result!.legacyAuditVerified=false;
  const stopped=await stale.run(); assert.equal(stopped.status,'manual'); assert.match(stopped.state.lastError,/续期的现场回执不足.*德立云当前到期日已变化/);
  assert.equal(stale.jobs.length,0); assert.equal(stale.writes.length,0);
  const pending=fixture(); assert.equal((await pending.run({},'off')).status,'manual'); assert.equal(pending.jobs.length,0);
});

test('原有效期读回必须匹配原车及其任务，开始日期被修改时停下', () => {
  const f=fixture();
  f.local.result!.previousStartDate='2026-02-01';
  assert.equal(planVerifiedParkingReversal(f.original,f.local,plate),null);
  f.cloud.result!.vehicleId='wrong'; assert.equal(planVerifiedParkingReversal(f.original,f.cloud,plate),null);
  f.cloud.result!.vehicleId='cloud-v1'; f.cloud.result!.previousEndDate='2026-02-31';
  assert.equal(planVerifiedParkingReversal(f.original,f.cloud,plate),null);
});

test('后续收费检查按公司及标准化车牌过滤，已红冲后续单不算有效收款', async t => {
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`CREATE TABLE business_transactions (id int, tenant_id int, service_type text, status text, snapshot jsonb);
    INSERT INTO business_transactions VALUES(7,1,'parking_monthly','paid','{"vehicle":{"plateNo":"沪T12345"}}'),
    (8,2,'parking_monthly','paid','{"vehicle":{"plateNo":"沪T12345"}}'),
    (9,1,'parking_monthly','paid','{"parking":{"plate":"沪 T12345"},"reversedByTxnNo":"PKR-9"}');`);
  const manager:any={query:async (sql:string,params:any[]) => (await db.query(sql,params)).rows};
  assert.equal(await hasLaterParkingPayment(manager,1,7,plate),false);
  await db.exec("UPDATE business_transactions SET snapshot=snapshot-'reversedByTxnNo' WHERE id=9");
  assert.equal(await hasLaterParkingPayment(manager,1,7,plate),true);
});
