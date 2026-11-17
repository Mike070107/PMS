import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { VehicleIntakeService } from './vehicle-intake.service';
import { BusinessLog, BusinessTransaction, ParkingSpace, VehicleIntake } from '../../entities';

// Real PostgreSQL/WASM transaction persistence and rollback, not a live DB or multi-session contention test.
// Repository adapter stores entity-shaped JSONB and executes real SELECT FOR UPDATE + advisory SQL on the same transaction.
test('staff approval persists garage binding and rolls back all prior writes on conflict (PGlite SQL)', async () => {
  const db = new PGlite();
  await db.exec('CREATE TABLE fixture_entities (entity text, id int, data jsonb NOT NULL, PRIMARY KEY(entity,id))');
  const sqlCalls: string[] = [];
  const revive = (row: any) => { if (!row) return null; for (const key of ['expiresAt', 'createdAt', 'updatedAt', 'submittedAt', 'reviewedAt', 'openedAt']) if (row[key]) row[key] = new Date(row[key]); return row; };
  function managerFor(connection: any): any {
    const manager: any = {
      query: async (sql: string, parameters: any[]) => { sqlCalls.push(sql); return (await connection.query(sql, parameters)).rows; },
      save: async () => {}, create: (_entity: any, value: any) => value,
      getRepository: (entity: any) => repository(entity, manager, connection),
      transaction: async (work: any) => db.transaction(tx => work(managerFor(tx))),
    };
    return manager;
  }
  function repository(entity: any, manager: any, connection: any): any {
    return {
      manager, create: (data: any) => data,
      findOne: async (options: any) => {
        const sql = 'SELECT data FROM fixture_entities WHERE entity=$1 AND data @> $2::jsonb ORDER BY id LIMIT 1' + (options.lock ? ' FOR UPDATE' : '');
        sqlCalls.push(sql); return revive((await connection.query(sql, [entity.name, JSON.stringify(options.where)])).rows[0]?.data);
      },
      save: async (value: any) => {
        const id = value.id || 1; const result = { ...value, id };
        await connection.query('INSERT INTO fixture_entities(entity,id,data) VALUES($1,$2,$3) ON CONFLICT(entity,id) DO UPDATE SET data=excluded.data', [entity.name, id, JSON.stringify(result)]);
        return revive(structuredClone(result));
      },
      createQueryBuilder: () => {
        let params: any; const qb: any = { where: (_s: string, p: any) => { params = p; return qb; }, getOne: async () => revive((await connection.query(`SELECT data FROM fixture_entities WHERE entity=$1 AND (data->>'tenantId')::int=$2 AND data->>'plate'=$3 AND id<>$4 AND data->>'status'<>$5 LIMIT 1`, [entity.name, params.tenantId, params.plate, params.id, params.status])).rows[0]?.data) }; return qb;
      },
    };
  }
  const manager = managerFor(db), intakes = manager.getRepository(VehicleIntake);
  const now = new Date(); const user: any = { id: 8, tenantId: 1 };
  await intakes.save({ id: 1, tenantId: 1, communityId: 3, houseId: 5, houseLabel: '枫桦景苑二期/228弄3号502', kind: 'paid', status: 'submitted', plate: '沪A12345', contactName: '合成车主', contactPhone: '13900000000', ownerName: '合成业主', ownerPhone: '', relation: '', vehicleClass: '', garages: ['local:phase2_parking', 'local:phase2_main_garage', 'deliyun:枫桦景苑'], garageNumbers: { main: 'B12', civil: 'C12' }, files: [], log: [], expiresAt: new Date(Date.now() + 3600000), createdAt: now, submittedAt: now, transactionId: null });
  const spaces = manager.getRepository(ParkingSpace);
  await spaces.save({ id: 1, tenantId: 1, communityId: 3, garage: 'civil', spaceNo: 'C12', plate: null, houseNo: null });
  await spaces.save({ id: 2, tenantId: 1, communityId: 3, garage: 'main', spaceNo: 'B12', plate: '沪B22222', houseNo: '另一户' });
  const service = new VehicleIntakeService(intakes, manager.getRepository(BusinessTransaction), manager.getRepository(BusinessLog), {} as any, {} as any, { findOne: async () => ({ name: '枫桦景苑二期' }) } as any, { findOne: async () => ({ id: 8, name: '合成前台' }) } as any, {} as any, {} as any, {} as any, {} as any);
  try {
    await assert.rejects(service.review(1, { decision: 'approve' }, user), /不能抢占/);
    assert.equal((await spaces.findOne({ where: { id: 1 } })).plate, null, 'civil write rolled back after main conflict');
    assert.equal((await intakes.findOne({ where: { id: 1 } })).status, 'submitted');
    await spaces.save({ id: 2, tenantId: 1, communityId: 3, garage: 'main', spaceNo: 'B12', plate: null, houseNo: null });
    await service.review(1, { decision: 'approve' }, user);
    assert.equal((await intakes.findOne({ where: { id: 1 } })).status, 'approved');
    for (const id of [1, 2]) { const stored = await spaces.findOne({ where: { id } }); assert.equal(stored.plate, '沪A12345'); assert.equal(stored.houseNo, '228弄3号502'); }
    const manual = await spaces.findOne({ where: { id: 2 } }); await spaces.save({ ...manual, ownerName: '人工后改' });
    await assert.rejects(service.review(1, { decision: 'void', note: '合成撤回' }, user), /已被修改/);
    assert.equal((await spaces.findOne({ where: { id: 1 } })).plate, '沪A12345', 'earlier civil restoration must roll back on later manual conflict');
    assert.equal((await intakes.findOne({ where: { id: 1 } })).status, 'approved');
    await spaces.save(manual);
    await service.review(1, { decision: 'void', note: '合成撤回' }, user);
    await service.review(1, { decision: 'void', note: '合成撤回重试' }, user);
    assert.equal((await spaces.findOne({ where: { id: 1 } })).plate, null);
    assert.equal((await spaces.findOne({ where: { id: 2 } })).plate, null);
    assert.equal((await intakes.findOne({ where: { id: 1 } })).status, 'void');
    assert.ok(sqlCalls.some(sql => sql.includes('pg_advisory_xact_lock')));
    assert.ok(sqlCalls.filter(sql => sql.includes('FOR UPDATE')).length >= 6);
  } finally { await db.close(); }
});
