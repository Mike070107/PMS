import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { claimVehicleRegistration, releaseVehicleRegistration, VEHICLE_CLAIM_CONFLICT } from './vehicle-registration-claim';
import { VehicleRegistrationClaims1796500000000 } from '../migrations/1796500000000-VehicleRegistrationClaims';

// Executes actual PostgreSQL statements and transaction rollback, not multi-connection race proof.
test('跨流程占用：历史冲突、别名移交、租户、续登、改牌及事务回滚', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE family_cars(id integer PRIMARY KEY, tenant_id integer, house_id integer, previous_id integer, plate text, status text);
    CREATE TABLE vehicle_intakes(id integer PRIMARY KEY, tenant_id integer, house_id integer, family_car_id integer REFERENCES family_cars(id), plate text, status text, transaction_id integer)`);
  const migration = new VehicleRegistrationClaims1796500000000();
  await migration.up({ query: (sql: string) => db.query(sql) } as any);
  await migration.up({ query: (sql: string) => db.query(sql) } as any);
  const transaction = (work: (manager: any) => Promise<unknown>) => db.transaction(tx => work({ queryRunner: { isTransactionActive: true }, query: async (sql: string, args: any[]) => (await tx.query(sql, args)).rows }));
  const claim = (owner: any) => transaction(manager => claimVehicleRegistration(manager, owner));
  const count = async () => Number((await db.query<any>('SELECT count(*) AS n FROM vehicle_registration_claims')).rows[0].n);
  await assert.rejects(claimVehicleRegistration({} as any, { tenantId: 1, plate: '沪A12345', intakeId: 1 }), /caller transaction/);
  await db.exec(`INSERT INTO vehicle_intakes(id,tenant_id,house_id,family_car_id,plate,status) VALUES (1,1,5,NULL,'沪a·12345','submitted'),(2,1,6,NULL,'沪A12345','waiting'),(3,2,5,NULL,'沪A12345','submitted')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪 A12345', intakeId: 2 }), error => { assert.equal((error as Error).message, VEHICLE_CLAIM_CONFLICT); assert.ok(!(error as Error).message.includes('房')); return true; });
  assert.equal(await count(), 0, 'conflicts never choose a historical winner');
  await db.query("UPDATE vehicle_intakes SET status='void' WHERE id=2");
  await claim({ tenantId: 1, plate: '沪a.12345', intakeId: 1 });
  await claim({ tenantId: 2, plate: '沪A12345', intakeId: 3 });
  assert.equal(await count(), 2, 'same plate is independent between tenants');
  await db.exec(`INSERT INTO family_cars VALUES (11,1,5,NULL,'沪A12345','office')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪A12345', familyCarId: 11 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await claim({ tenantId: 1, plate: '沪A12345', familyCarId: 11, intakeId: 1 });
  await db.query('UPDATE vehicle_intakes SET family_car_id=11 WHERE id=1');
  await claim({ tenantId: 1, plate: '沪A12345', familyCarId: 11 });
  assert.deepEqual((await db.query('SELECT intake_id,family_car_id FROM vehicle_registration_claims WHERE tenant_id=1')).rows, [{ intake_id: 1, family_car_id: 11 }]);
  await db.exec(`UPDATE family_cars SET status='active' WHERE id=11; INSERT INTO family_cars VALUES (12,1,6,11,'沪A12345','office')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪A12345', familyCarId: 12 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await db.query('UPDATE family_cars SET house_id=5 WHERE id=12');
  // The active predecessor's linked intake remains untouched; it is the same canonical record.
  await claim({ tenantId: 1, plate: '沪A12345', familyCarId: 12 });
  await db.exec(`INSERT INTO family_cars VALUES (13,1,5,11,'沪A12345','returned')`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪A12345', familyCarId: 13 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await db.query("UPDATE family_cars SET status='void' WHERE id=13");
  await assert.rejects(transaction(async manager => {
    await manager.query("INSERT INTO vehicle_intakes(id,tenant_id,house_id,family_car_id,plate,status) VALUES (4,1,8,NULL,'沪B12345','submitted')", []);
    await claimVehicleRegistration(manager, { tenantId: 1, plate: '沪B12345', intakeId: 4 });
    throw Error('synthetic transaction failure');
  }), /synthetic/);
  assert.equal((await db.query('SELECT id FROM vehicle_intakes WHERE id=4')).rows.length, 0);
  assert.equal((await db.query("SELECT plate FROM vehicle_registration_claims WHERE plate='沪B12345'")).rows.length, 0);
  await transaction(async manager => {
    await manager.query("UPDATE vehicle_intakes SET plate='沪C12345' WHERE id=3", []);
    await claimVehicleRegistration(manager, { tenantId: 2, plate: '沪C12345', intakeId: 3 });
  });
  assert.deepEqual((await db.query('SELECT plate FROM vehicle_registration_claims WHERE tenant_id=2')).rows, [{ plate: '沪C12345' }]);
  await transaction(manager => releaseVehicleRegistration(manager, 1, 'family', 12));
  assert.equal((await db.query('SELECT plate FROM vehicle_registration_claims WHERE tenant_id=1')).rows.length, 0);
  await db.exec(`INSERT INTO vehicle_intakes(id,tenant_id,house_id,plate,status,transaction_id) VALUES (5,1,5,'沪D12345','void',42),(6,1,6,'沪D12345','submitted',NULL)`);
  await assert.rejects(claim({ tenantId: 1, plate: '沪D12345', intakeId: 6 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  assert.equal((await db.query("SELECT transaction_id FROM vehicle_intakes WHERE id=5")).rows.length, 1, 'historical collected/void records are held, never silently cleared');
  await assert.rejects(migration.down(), /retained/);
});
