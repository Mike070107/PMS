import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertPreservedReceipt, validatePreservedOperation, VEHICLE_IDENTITIES } from './parking-vehicle-preservation';
import { preservePlateBilling } from './parking-plate-billing';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { DataSource } from 'typeorm';
import { ParkingOperation } from '../../entities/parking-operation.entity';

test('actual TypeORM claim SQL groups every OR behind tenant/status/capability filters', async () => {
  const ds = new DataSource({ type: 'postgres', entities: [ParkingOperation] });
  await (ds as any).buildMetadatas(); // No network connection; compile the real service query.
  for (const capable of [false, true]) {
    let sql = '';
    const service: any = Object.create(AccessCardIssuanceService.prototype);
    service.authenticateAgent = async () => ({ tenantId: 77, agentKey: 'gateway', kind: 'parking_gateway', version: '2.5.53', capabilities: { parkingDbWrite: true, parkingVehiclePreservationV1: capable } });
    const repository = ds.getRepository(ParkingOperation), actualBuilder = repository.createQueryBuilder.bind(repository);
    const fakeRepo = { createQueryBuilder: (alias: string) => {
      const builder = actualBuilder(alias);
      builder.getOne = async () => { sql = builder.getSql(); assert.equal(builder.getParameters().tenantId, 77); return null; };
      return builder;
    } };
    service.parkingOperationRepo = { manager: { transaction: async (run: any) => run({ getRepository: () => fakeRepo }) } };
    await service.claimParkingOperation('gateway', 'token');
    const condition = sql.slice(sql.indexOf(' WHERE '), sql.indexOf(' ORDER BY '));
    let depth = 0;
    for (let i = 0; i < condition.length; i++) {
      if (condition[i] === '(') depth++; else if (condition[i] === ')') depth--;
      if (condition.slice(i, i + 4) === ' OR ') assert.ok(depth > 0, `ungrouped OR: ${sql}`);
    }
    assert.equal(depth, 0); assert.match(sql, /tenant_id/); assert.match(sql, /lease_expires_at/);
    assert.match(sql, /batchTargets/); assert.match(sql, /sourceQueryId/); assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /preservationAgentKey/); assert.match(sql, /preservationContract/);
    if (!capable) assert.match(sql, /NOT IN \('change_plate', 'update_vehicle_type'\)/);
  }
});

const payload = () => ({ plate: '测A12345', newPlate: '测B12345', batchId: 'original-batch-123', sourceQueryId: 18 });
const before = (identity: unknown = null) => ({ P_id: 5045, P_plate: '测A12345', Car_Lei: null, Car_Beand: identity,
  Owner_ID: 'original-owner', End_Time: '2027-01-02', Sart_Time: null, Car_Money: 20, Car_Deposit: 3, Car_Zt: 0,
  Car_ID: 'raw-card', P_Color: null, P_note: '原备注', P_Effective: '001000', P_Download: '01000', P_Spaces: '原车位', P_Admin: '旧管理员' });
const task = (database = 'parking1') => ({ id: 1, tenantId: 2, createdBy: 3, kind: 'change_plate', database, sourceRecordId: '5045',
  payload: payload(), status: 'running', expected: { preservationContract: 1, preservationAgentKey: 'gateway', billingTag: { id: 9, vehicleClass: '住户车-1', houseId: 7 },
    batchTargets: [{ database: 'parking1', sourceRecordId: '5045' }, { database: 'parking2', sourceRecordId: '5046' }] } });
const receipt = (identity: unknown = null) => ({ verified: true, preserved: true, preservationContract: 1, database: 'parking1', issueId: 5045,
  plate: '测B12345', previousPlate: '测A12345', before: before(identity), after: { ...before(identity), P_plate: '测B12345', P_Admin: 'PMS' } });

test('snapshot recovery remains pinned to the original assistant, never a second gateway', async () => {
  const op: any = { ...task(), attempt: 0, expected: { preservationContract: 1 } };
  const service: any = Object.create(AccessCardIssuanceService.prototype);
  let agentKey = 'gateway';
  service.authenticateAgent = async () => ({ agentKey, tenantId: 2, kind: 'parking_gateway', version: '2.5.53', capabilities: { parkingDbWrite: true, parkingVehiclePreservationV1: true } });
  const chain: any = { where() { return this; }, andWhere() { return this; }, orderBy() { return this; }, setLock() { return this; }, setOnLocked() { return this; }, getOne: async () => op };
  const repo = { createQueryBuilder: () => chain, save: async (value: any) => value };
  service.parkingOperationRepo = { manager: { transaction: async (run: any) => run({ getRepository: () => repo }) } };
  await service.claimParkingOperation('gateway', 'token'); assert.equal(op.expected.preservationAgentKey, 'gateway'); assert.equal(op.attempt, 1);
  agentKey = 'other-machine'; await assert.rejects(() => service.claimParkingOperation(agentKey, 'token')); assert.equal(op.attempt, 1);
  agentKey = 'gateway'; await service.claimParkingOperation('gateway', 'token'); assert.equal(op.attempt, 2);
});

function creationHarness() {
  const service: any = Object.create(AccessCardIssuanceService.prototype);
  const state: any = { existing: null, sibling: null, duplicate: null, saved: null, capable: true,
    query: { id: 18, database: null, status: 'completed', queryKind: 'vehicle', term: '测A12345', completedAt: new Date(),
      rows: [{ database: 'parking1', fields: before() }, { database: 'parking2', fields: { ...before('租户车'), P_id: 5046 } }] } };
  service.requireTenant = () => 2; service.parkingOperationResponse = (value: any) => value;
  service.agentRepo = { find: async () => [{ kind: 'parking_gateway', version: '2.5.53', status: 'online', enabled: true, lastSeenAt: new Date(), capabilities: { parkingDbWrite: true, parkingVehiclePreservationV1: state.capable } }] };
  service.parkingQueryRepo = { findOne: async () => state.query };
  let builderCount = 0;
  service.parkingOperationRepo = { findOne: async () => state.existing,
    create: (value: any) => value, save: async (value: any) => (state.saved = value),
    manager: { getRepository: () => ({ findOne: async () => null }) },
    createQueryBuilder: () => { const index = builderCount++; const chain: any = { where() { return this; }, andWhere() { return this; }, orderBy() { return this; }, getOne: async () => index === 0 ? state.sibling : state.duplicate }; return chain; } };
  return { service, state, dto: { idempotencyKey: 'original-key', kind: 'change_plate', database: 'parking1', sourceRecordId: '5045', payload: payload() } };
}

test('creation derives exact dual-database targets and ignores client-owned expected values', async () => {
  const { service, state, dto } = creationHarness();
  const created = await service.createParkingOperation({ ...dto, expected: { preservationContract: 999, preservationAgentKey: 'attacker', billingTag: { vehicleClass: '伪造' } } }, { id: 3 });
  assert.equal(created.expected.preservationContract, 1); assert.equal(created.expected.preservationAgentKey, undefined); assert.equal(created.expected.billingTag, null);
  assert.deepEqual(created.expected.batchTargets, [{ database: 'parking1', sourceRecordId: '5045' }, { database: 'parking2', sourceRecordId: '5046' }]);
  assert.equal(state.saved, created);
});

test('creation rejects incomplete/stale/foreign query targets and non-capable gateways', async () => {
  for (const mutate of [
    (s: any) => { s.query.status = 'failed'; },
    (s: any) => { s.query.database = 'parking1'; },
    (s: any) => { s.query.completedAt = new Date(Date.now() - 301_000); },
    (s: any) => { s.query.rows[1].database = 'unknown'; },
    (s: any) => { s.query.rows[1].database = 'parking1'; },
    (s: any) => { s.capable = false; },
  ]) {
    const { service, state, dto } = creationHarness(); mutate(state);
    await assert.rejects(() => service.createParkingOperation(dto, { id: 3 })); assert.equal(state.saved, null);
  }
});

test('immutable request keys cannot change sources, kind, payload, or create a duplicate batch target', async () => {
  for (const change of [{ database: 'parking2' }, { sourceRecordId: '5046' }, { payload: { ...payload(), newPlate: '测C12345' } }, { kind: 'renew_vehicle' }]) {
    const { service, state, dto } = creationHarness(); state.existing = task();
    await assert.rejects(() => service.createParkingOperation({ ...dto, ...change }, { id: 3 })); assert.equal(state.saved, null);
  }
  const { service, state, dto } = creationHarness(); state.duplicate = { id: 44 };
  await assert.rejects(() => service.createParkingOperation(dto, { id: 3 }), /原任务 #44/); assert.equal(state.saved, null);
});

test('plate allows only identifiers and a completed-query credential; raw null extras are rejected', () => {
  validatePreservedOperation('change_plate', payload(), '5045');
  for (const key of ['identity', 'carType', 'vehicleClass', 'endDate', 'ownerName', 'expected'])
    assert.throws(() => validatePreservedOperation('change_plate', { ...payload(), [key]: null }, '5045'));
  assert.throws(() => validatePreservedOperation('change_plate', payload(), ''));
  assert.throws(() => validatePreservedOperation('change_plate', { ...payload(), sourceQueryId: 0 }, '5045'));
});
test('independent identity accepts three literals, never numeric coding or billing labels', () => {
  for (const identity of VEHICLE_IDENTITIES) validatePreservedOperation('update_vehicle_type', { plate: '测A12345', identity }, '5045');
  for (const identity of ['1', 1, '', '住户车-1', null, '月租']) assert.throws(() => validatePreservedOperation('update_vehicle_type', { plate: '测A12345', identity }, '5045'));
});
test('plate receipt preserves null/nonstandard/string code originals independently', () => {
  for (const identity of [null, '历史 非标准', '1', '租户车']) assertPreservedReceipt(task(), receipt(identity));
  const other = { ...task('parking2'), sourceRecordId: '5046' };
  const second = receipt('亲情车'); second.database = 'parking2'; second.issueId = 5046; second.before.P_id = 5046; second.after.P_id = 5046;
  assertPreservedReceipt(other, second);
  second.after.P_Effective = '001'; assert.throws(() => assertPreservedReceipt(other, second));
});
test('every original business field drift and incomplete receipt fails closed', () => {
  for (const key of Object.keys(before())) {
    if (['P_plate', 'P_Admin'].includes(key)) continue;
    const value: any = receipt(); value.after[key] = 'changed'; assert.throws(() => assertPreservedReceipt(task(), value), key);
    const missing: any = receipt(); delete missing.before[key]; delete missing.after[key];
    if (key !== 'Car_Beand') assert.throws(() => assertPreservedReceipt(task(), missing), `missing ${key}`);
    else assert.throws(() => assertPreservedReceipt(task(), missing));
  }
  const conflicting: any = receipt(); conflicting.before.Car_Brand = '1'; conflicting.after.Car_Brand = '1';
  assert.throws(() => assertPreservedReceipt(task(), conflicting));
  assert.throws(() => assertPreservedReceipt(task(), { verified: true }));
});
test('type change ignores only intended identity columns', () => {
  const typeTask = { ...task(), kind: 'update_vehicle_type', payload: { plate: '测A12345', identity: '住户车' } };
  const value: any = { ...receipt('1'), plate: '测A12345', after: { ...before('住户车'), P_Admin: 'PMS' } };
  assertPreservedReceipt(typeTask, value);
  value.after.Car_Lei = '1'; assert.throws(() => assertPreservedReceipt(typeTask, value));
});

function billingFixture(hasTag = true) {
  const first: any = task(); const second: any = { ...task('parking2'), id: 2, sourceRecordId: '5046' };
  if (!hasTag) { first.expected.billingTag = null; second.expected.billingTag = null; }
  const rows: any[] = hasTag ? [{ id: 9, tenantId: 2, plate: '测A12345', vehicleClass: '住户车-1', houseId: 7 }] : [];
  const siblings = [first, second]; let locks = 0;
  const builder = { where() { return this; }, andWhere() { return this; }, orderBy() { return this; }, setLock() { locks++; return this; }, async getMany() { return rows; } };
  const tags: any = { createQueryBuilder: () => builder, create: (v: any) => ({ id: 10, ...v }),
    save: async (v: any) => { if (!rows.some(row => row.id === v.id)) rows.push(v); return v; },
    remove: async (v: any) => { rows.splice(rows.findIndex(row => row.id === v.id), 1); return v; } };
  const ops: any = { createQueryBuilder: () => ({ where() { return this; }, andWhere() { return this; }, async getMany() { assert.ok(locks > 0); return siblings; } }) };
  return { first, second, rows, tags, ops };
}
test('first-source success keeps exact original billing on old and new plates; second finalizes original ID', async () => {
  const f = billingFixture(); await preservePlateBilling(f.first, f.tags, f.ops);
  assert.deepEqual(f.rows.map(r => [r.plate, r.vehicleClass, r.houseId]), [['测A12345', '住户车-1', 7], ['测B12345', '住户车-1', 7]]);
  assert.equal(f.first.expected.billingTargetTagId, 10);
  f.first.status = 'completed'; f.first.result = { verified: true, preserved: true };
  await preservePlateBilling(f.second, f.tags, f.ops);
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].id, 9); assert.equal(f.rows[0].plate, '测B12345');
});
test('failed or unknown second source keeps both categories without early source migration', async () => {
  const f = billingFixture(); f.second.status = 'failed'; await preservePlateBilling(f.first, f.tags, f.ops);
  assert.equal(f.rows[0].plate, '测A12345'); assert.equal(f.rows[1].vehicleClass, '住户车-1');
});
test('unknown target provenance and original billing drift never overwrite categories', async () => {
  const f = billingFixture(); f.rows.push({ id: 20, plate: '测B12345', vehicleClass: '住户车-1', houseId: 7 });
  await assert.rejects(() => preservePlateBilling(f.first, f.tags, f.ops));
  f.rows.pop(); f.rows[0].vehicleClass = '其他档'; await assert.rejects(() => preservePlateBilling(f.first, f.tags, f.ops));
});
test('no original category never fabricates a default or copies another plate category', async () => {
  const f = billingFixture(false); await preservePlateBilling(f.first, f.tags, f.ops); assert.equal(f.rows.length, 0);
  f.rows.push({ id: 20, plate: '测B12345', vehicleClass: '住户车-1', houseId: 7 });
  await assert.rejects(() => preservePlateBilling(f.first, f.tags, f.ops));
});
test('completed duplicate receipt is acknowledged once with no history/tag writes, still capability gated', async () => {
  const op: any = { ...task(), status: 'completed', result: receipt() };
  const service: any = Object.create(AccessCardIssuanceService.prototype);
  const agent: any = { kind: 'parking_gateway', tenantId: 2, agentKey: 'gateway', capabilities: { parkingVehiclePreservationV1: true } };
  service.authenticateAgent = async () => agent;
  const repo = { findOne: async ({ where }: any) => { assert.equal(where.tenantId, 2); return op; }, save: () => assert.fail('duplicate must not write') };
  service.parkingOperationRepo = { manager: { transaction: async (run: any) => run({ getRepository: () => repo }) } };
  await service.reportParkingOperation('gateway', 'token', { taskId: 1, result: 'success', values: receipt() });
  const altered: any = receipt(); altered.before.P_note = 'other'; altered.after.P_note = 'other';
  await assert.rejects(() => service.reportParkingOperation('gateway', 'token', { taskId: 1, result: 'success', values: altered }));
  agent.capabilities.parkingVehiclePreservationV1 = false;
  await assert.rejects(() => service.reportParkingOperation('gateway', 'token', { taskId: 1, result: 'success', values: receipt() }));
});
