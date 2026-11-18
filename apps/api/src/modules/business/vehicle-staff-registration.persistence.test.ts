import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { VehicleIntakeService } from './vehicle-intake.service';
import { BusinessLog, BusinessTransaction, ParkingSpace, VehicleIntake } from '../../entities';

// Real PostgreSQL/WASM transaction persistence and rollback, not a live DB or multi-session contention test.
// Repository adapter stores entity-shaped JSONB and executes real SELECT FOR UPDATE + advisory SQL on the same transaction.
test('staff contact isolation persists; shared-space approval never overwrites master records (PGlite SQL)', async () => {
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
      find: async (options: any) => {
        const where = { ...options.where }; const ids = where.communityId?._value; delete where.communityId;
        const sql = 'SELECT data FROM fixture_entities WHERE entity=$1 AND data @> $2::jsonb AND (data->>\'communityId\')::int=ANY($3::int[])' + (options.lock ? ' FOR UPDATE' : '');
        sqlCalls.push(sql); return (await connection.query(sql, [entity.name, JSON.stringify(where), ids])).rows.map((r: any) => revive(r.data));
      },
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
        let params: any, patch: any; const qb: any = { update: () => qb, set: (data: any) => { patch = data; return qb; }, execute: async () => {
          const result = await connection.query('UPDATE fixture_entities SET data=data || $1::jsonb WHERE entity=$2 AND id=$3 AND data->>\'status\'=ANY($4::text[]) RETURNING id', [JSON.stringify(patch), entity.name, params.id, params.st]);
          return { affected: result.rows.length };
        }, where: (_s: string, p: any) => { params = p; return qb; }, getOne: async () => revive((await connection.query(`SELECT data FROM fixture_entities WHERE entity=$1 AND (data->>'tenantId')::int=$2 AND data->>'plate'=$3 AND id<>$4 AND data->>'status'<>$5 LIMIT 1`, [entity.name, params.tenantId, params.plate, params.id, params.status])).rows[0]?.data) }; return qb;
      },
    };
  }
  const manager = managerFor(db), intakes = manager.getRepository(VehicleIntake);
  const now = new Date(); const user: any = { id: 8, tenantId: 1 };
  await intakes.save({ id: 1, tenantId: 1, communityId: 3, houseId: 5, houseLabel: '枫桦景苑二期/228弄3号502', kind: 'paid', status: 'submitted', plate: '沪A12345', contactName: '合成车主', contactPhone: '13900000000', ownerName: '合成业主', ownerPhone: '', relation: '', vehicleClass: '', garages: ['local:phase2_parking', 'local:phase2_main_garage', 'deliyun:枫桦景苑'], garageNumbers: { main: 'B12', civil: 'C12' }, files: [], log: [], expiresAt: new Date(Date.now() + 3600000), createdAt: now, submittedAt: now, transactionId: null });
  const spaces = manager.getRepository(ParkingSpace);
  await spaces.save({ id: 1, tenantId: 1, communityId: 3, garage: 'civil', spaceNo: 'C12', plate: null, houseNo: null });
  await spaces.save({ id: 2, tenantId: 1, communityId: 3, garage: 'main', spaceNo: 'B12', plate: '沪B22222', houseNo: '另一户' });
  const service = new VehicleIntakeService(intakes, manager.getRepository(BusinessTransaction), manager.getRepository(BusinessLog), {} as any, {} as any, { findOne: async () => ({ id: 3, name: '枫桦景苑二期' }), find: async () => [{ id: 3, name: '枫桦景苑二期' }] } as any, { findOne: async () => ({ id: 8, name: '合成前台' }) } as any, {} as any, {} as any, {} as any, {} as any);
  try {
    // Separate plates in the same household: real JSONB update, commit and service reload.
    for (const [id, plate, phone] of [[2, '沪C12345', '13711112222'], [3, '沪D12345', '13633334444']] as const) {
      await intakes.save({ ...(await intakes.findOne({ where: { id: 1 } })), id, status: 'waiting', plate: '', ownerPhone: '13800000000', garages: ['local:phase2_parking'], garageNumbers: {} });
      await service.staffSubmit(id, { plate, contactPhone: phone, ownerPhone: '13099998888' }, user);
    }
    const firstCar = await service.get(2, user), secondCar = await service.get(3, user);
    assert.equal(firstCar.contactPhone, '13711112222'); assert.equal(secondCar.contactPhone, '13633334444');
    assert.equal(firstCar.ownerPhone, '13800000000'); assert.equal(secondCar.ownerPhone, '13800000000');
    const original = await intakes.findOne({ where: { id: 1 } });
    await intakes.save({ ...original, garageNumbers: { main: 'INVALID', civil: 'C12' } });
    await assert.rejects(service.review(1, { decision: 'approve' }, user), /所选车库/);
    assert.equal((await intakes.findOne({ where: { id: 1 } })).status, 'submitted');
    assert.equal((await spaces.findOne({ where: { id: 1 } })).plate, null);
    await intakes.save(original);
    await service.review(1, { decision: 'approve' }, user);
    const approved = await service.get(1, user);
    assert.equal(approved.status, 'approved');
    assert.equal((approved.log!.find((l: any) => l.action === '关联共用车位') as any).spaceReferences.length, 2);
    assert.equal((await spaces.findOne({ where: { id: 1 } })).plate, null);
    assert.equal((await spaces.findOne({ where: { id: 2 } })).plate, '沪B22222');
    await service.review(1, { decision: 'void', note: '合成撤回' }, user);
    await service.review(1, { decision: 'void', note: '合成撤回重试' }, user);
    assert.equal((await spaces.findOne({ where: { id: 1 } })).plate, null);
    assert.equal((await spaces.findOne({ where: { id: 2 } })).plate, '沪B22222');
    assert.equal((await intakes.findOne({ where: { id: 1 } })).status, 'void');
    assert.ok(sqlCalls.some(sql => sql.includes('pg_advisory_xact_lock')));
    assert.ok(sqlCalls.filter(sql => sql.includes('FOR UPDATE')).length >= 6);
  } finally { await db.close(); }
});
