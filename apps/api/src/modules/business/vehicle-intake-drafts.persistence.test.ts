import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DataSource } from 'typeorm';
import { VehicleIntake } from '../../entities/vehicle-intake.entity';
import { VehicleIntakeOperations1796300000000 } from '../../migrations/1796300000000-VehicleIntakeOperations';
import { VehicleMaterialVersions1796600000000 } from '../../migrations/1796600000000-VehicleMaterialVersions';
import { VehicleIntakeService } from './vehicle-intake.service';

// Execute actual TypeORM SELECT/INSERT/UPDATE SQL and migration in an isolated PG engine.
// This fixture never opens a network socket or production configuration.
test('QR draft operations: transactional reuse, replay, expiry, history, isolation and rollback', async () => {
  const db = new PGlite();
  const source = new DataSource({ type: 'postgres', entities: [VehicleIntake] });
  await (source as any).buildMetadatas();
  const orm = source.getRepository(VehicleIntake);
  const metadata = orm.metadata;
  const driver = source.driver;
  const cols = metadata.columns;
  try {
    const ddl = cols.map(c => {
      if (c.isPrimary) return 'id serial PRIMARY KEY';
      const type = driver.normalizeType(c) + (c.length ? `(${c.length})` : '');
      const value = c.isCreateDate || c.isUpdateDate ? 'now()' : driver.normalizeDefault(c);
      return `"${c.databaseName}" ${type}${c.isNullable ? '' : ' NOT NULL'}${value !== undefined ? ` DEFAULT ${value}` : ''}`;
    }).join(',');
    await db.exec(`CREATE TABLE houses (id int PRIMARY KEY, tenant_id int NOT NULL);
      INSERT INTO houses VALUES (5,1),(6,1),(7,2);
      CREATE TABLE family_cars (id int PRIMARY KEY);
      CREATE TABLE vehicle_intakes (${ddl});`);
    const migration = new VehicleIntakeOperations1796300000000();
    await migration.up({ query: (sql: string) => db.query(sql) } as any);
    await migration.up({ query: (sql: string) => db.query(sql) } as any);
    const versions = new VehicleMaterialVersions1796600000000();
    await versions.up({ query: (sql: string) => db.query(sql) } as any);
    await versions.up({ query: (sql: string) => db.query(sql) } as any);
    const versionColumns = (await db.query<any>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'vehicle_intakes' AND column_name IN ('input_source','data_version','office_confirmed_version','registration_term','material_history')`)).rows.map((row: any) => row.column_name).sort();
    assert.deepEqual(versionColumns, ['data_version', 'input_source', 'material_history', 'office_confirmed_version', 'registration_term']);
    await assert.rejects(versions.down());
    const decode = (raw: any, prefix = '') => Object.fromEntries(cols.map(c => [c.propertyName, driver.prepareHydratedValue(raw[prefix + c.databaseName], c)]));
    const queryLog: string[] = [];
    let failRemember = false;
    const makeManager = (engine: any): any => {
      const manager: any = {
        query: async (sql: string, params: any[] = []) => {
          queryLog.push(sql);
          if (failRemember && sql.startsWith('INSERT INTO vehicle_intake_operations')) throw Error('synthetic commit failure');
          return (await engine.query(sql, params)).rows;
        },
        transaction: (work: any) => db.transaction(tx => work(makeManager(tx))),
      };
      const empty = { findOne: async () => null };
      const repo: any = {
        manager, create: (row: any) => ({ ...row }),
        find: async (options: any) => {
          const qb = orm.createQueryBuilder('draft').setFindOptions(options);
          const [sql, params] = qb.getQueryAndParameters();
          return (await manager.query(sql, params)).map((r: any) => decode(r, 'draft_'));
        },
        findOne: async (options: any) => (await repo.find({ ...options, take: 1 }))[0] ?? null,
        save: async (row: any) => {
          const { id, createdAt, updatedAt, ...values } = row;
          const qb = id ? orm.createQueryBuilder().update().set(values).where('id = :id', { id }) : orm.createQueryBuilder().insert().values(values);
          const [sql, params] = qb.returning('*').getQueryAndParameters();
          return decode((await manager.query(sql, params))[0]);
        },
      };
      manager.getRepository = (entity: any) => entity === VehicleIntake ? repo : empty;
      return manager;
    };
    const manager = makeManager(db);
    const service = new VehicleIntakeService(manager.getRepository(VehicleIntake), { findOne: async () => null } as any, {} as any,
      { findOne: async ({ where }: any) => { const r: any = (await db.query('SELECT * FROM houses WHERE id=$1 AND tenant_id=$2', [where.id, where.tenantId])).rows[0]; return r ? { id: r.id, buildingId: 2, roomNo: '502' } : null; } } as any,
      { findOne: async () => ({ communityId: 3, lane: '228', buildingNo: '3' }) } as any,
      { findOne: async () => ({ id: 3, name: '枫桦景苑二期' }) } as any,
      { findOne: async () => ({ name: '合成测试', phone: '13900000000' }) } as any,
      {} as any, {} as any, {} as any, { get: () => 'https://prsznh.cn' } as any);
    const user = { id: 10, tenantId: 1 } as any;
    const base = { houseId: 5, kind: 'paid' as const, formBase: 'https://prsznh.cn/beta/m/plate' };
    const key = (n: number) => `test_operation_${String(n).padStart(6, '0')}`;
    const count = async () => Number((await db.query<any>('SELECT count(*) AS n FROM vehicle_intakes')).rows[0].n);
    const initial = await service.create({ ...base, operationKey: key(1) }, user);
    assert.equal(initial.reused, false);
    const concurrent = await Promise.all([2,3,4,5].map(n => service.create({ ...base, operationKey: key(n) }, user)));
    assert.ok(concurrent.every(r => r.id === initial.id && r.qr?.url === initial.qr?.url));
    assert.equal(await count(), 1);
    assert.ok(queryLog.some(sql => /FROM houses .*FOR UPDATE/.test(sql)), 'server takes the DB house lock');
    assert.equal((await service.create({ ...base, operationKey: key(1) }, user)).id, initial.id, 'timeout replay resolves committed request');
    await assert.rejects(service.create({ ...base, houseId: 6, operationKey: key(1) }, user), /操作编号/);
    await assert.rejects(service.create({ ...base, kind: 'family', operationKey: key(1) }, user), /操作编号/);
    await assert.rejects(service.create({ ...base, operationKey: key(1) }, user, { scopeAll: false, communityIds: [] } as any), /管理范围/);
    assert.equal(await count(), 1);

    await db.query("UPDATE vehicle_intakes SET expires_at=now()-interval '2 hours', plate='沪A12345', contact_name='保留资料', transaction_id=42 WHERE id=$1", [initial.id]);
    const expired = await service.create({ ...base, operationKey: key(6) }, user);
    assert.equal(expired.id, initial.id); assert.equal(expired.qrExpired, true); assert.equal(expired.qr, undefined);
    assert.equal(expired.contactName, '保留资料'); assert.equal(expired.plate, '沪A12345');
    assert.equal((await db.query<any>('SELECT transaction_id FROM vehicle_intakes WHERE id=$1', [initial.id])).rows[0].transaction_id, 42);
    assert.equal(await count(), 1, 'expiration must not create a new registration');
    await assert.rejects(service.create({ ...base, anotherVehicle: true }, user), /操作编号/);
    const another = await service.create({ ...base, anotherVehicle: true, operationKey: key(7) }, user);
    assert.notEqual(another.id, initial.id);
    assert.deepEqual(another.otherDraftIds, [initial.id]);
    assert.equal((await service.create({ ...base, anotherVehicle: true, operationKey: key(7) }, user)).id, another.id, 'explicit new-vehicle action is itself idempotent');
    assert.equal((await service.create({ ...base, operationKey: key(8) }, user)).id, another.id, 'default continues latest, with other drafts disclosed');
    const exact = await service.get(initial.id, user);
    assert.equal(exact.id, initial.id, 'exact-ID access never substitutes the latest');
    assert.equal((await service.create({ ...base, operationKey: key(1) }, user)).id, initial.id, 'original key remains bound despite newer drafts');
    await db.query("UPDATE vehicle_intakes SET status='void' WHERE id=$1", [initial.id]);
    assert.equal((await service.create({ ...base, operationKey: key(1) }, user)).status, 'void', 'replay of cancelled operation does not resurrect it');
    const otherTenant = await service.create({ ...base, houseId: 7, operationKey: key(1) }, { id: 20, tenantId: 2 } as any);
    assert.notEqual(otherTenant.id, initial.id, 'operation identity is tenant scoped');
    const before = await count();
    failRemember = true;
    await assert.rejects(service.create({ ...base, anotherVehicle: true, operationKey: key(9) }, user), /synthetic commit failure/);
    failRemember = false;
    assert.equal(await count(), before, 'failed operation persistence rolls back the draft and audit together');
    assert.equal(Number((await db.query<any>('SELECT count(*) AS n FROM vehicle_intake_operations WHERE operation_key=$1', [key(9)])).rows[0].n), 0);
    await assert.rejects(migration.down(), /Retain/);
  } finally { await db.close(); }
});
