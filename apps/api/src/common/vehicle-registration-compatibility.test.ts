import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vehicleRegistrationCompatibility } from './vehicle-registration-compatibility';

test('只读兼容报告区分别名和跨流程冲突，不清理/回填历史数据', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE family_cars(id integer PRIMARY KEY,tenant_id integer,plate text,status text,
    registration_operation_id integer,open_operation_id integer,renew_operation_id integer,civil_operation_id integer,
    office_reviewed_by integer,office_reviewed_at timestamptz,manager_reviewed_by integer,manager_reviewed_at timestamptz);
    CREATE TABLE vehicle_intakes(id integer PRIMARY KEY,tenant_id integer,plate text,status text,family_car_id integer,transaction_id integer);
    INSERT INTO family_cars(id,tenant_id,plate,status,registration_operation_id) VALUES (11,1,'沪A12345','manager',77),(12,1,'沪 B·12345','opening',78),(13,2,'沪A12345','manager',79);
    INSERT INTO vehicle_intakes VALUES (1,1,'沪 A.12345','approved',11,NULL),(2,1,'沪B12345','returned',NULL,NULL),(3,1,'','waiting',NULL,NULL),(4,2,'沪B12345','submitted',NULL,NULL)`);
  const queries: string[] = [];
  const manager: any = { query: async (sql: string, args: unknown[]) => { queries.push(sql); return (await db.query(sql, args)).rows; } };
  await assert.rejects(vehicleRegistrationCompatibility(manager, 0), /explicit positive tenant/);
  const before = (await db.query('SELECT * FROM family_cars ORDER BY id')).rows;
  const report = await vehicleRegistrationCompatibility(manager, 1);
  assert.equal(report.readOnly, true); assert.equal(report.automaticCleanup, false);
  assert.deepEqual(report.potentialConflicts, [{ plate: '沪B12345', records: [{ kind: 'family', id: 12, status: 'opening' }, { kind: 'intake', id: 2, status: 'returned' }] }]);
  assert.deepEqual(report.preapprovalWriteLinks.map((row: any) => row.id), [11]);
  assert.deepEqual(report.openingWithoutApproval.map((row: any) => row.id), [12]);
  assert.ok(queries.every(sql => /^\s*(WITH|SELECT)\b/.test(sql)));
  assert.deepEqual((await db.query('SELECT * FROM family_cars ORDER BY id')).rows, before);
  assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE tablename='vehicle_registration_claims'")).rows.length, 0, 'report works before ownership migration and creates nothing');
});
