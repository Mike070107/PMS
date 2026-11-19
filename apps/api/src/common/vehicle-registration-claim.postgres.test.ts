import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { claimVehicleRegistration, VEHICLE_CLAIM_CONFLICT } from './vehicle-registration-claim';
import { VehicleRegistrationClaims1796500000000 } from '../migrations/1796500000000-VehicleRegistrationClaims';

const { Client } = require('pg');
const url = process.env.VEHICLE_TEST_PG_URL;

// Opt-in isolated loopback database ONLY. No application env/config import and no production credentials.
for (let round = 1; round <= 10; round++) test(`真实 PostgreSQL 多连接竞争与整体回滚（第${round}轮）`, { skip: !url, timeout: 30_000 }, async t => {
  const parsed = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
  assert.equal(parsed.pathname, '/vehicle_registration_test');
  const schema = `vehicle_claim_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: url }); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const clients: any[] = [];
  t.after(async () => {
    for (const client of clients) await client.end();
    // Schema is random, created above, in the explicitly isolated local test database.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  });
  const connect = async () => { const client = new Client({ connectionString: url }); await client.connect(); clients.push(client); await client.query(`SET search_path TO ${schema}`); return client; };
  const setup = await connect();
  await setup.query(`CREATE TABLE family_cars(id serial PRIMARY KEY,tenant_id integer,house_id integer,previous_id integer,plate text,status text);
    CREATE TABLE vehicle_intakes(id serial PRIMARY KEY,tenant_id integer,house_id integer,family_car_id integer REFERENCES family_cars(id),plate text,status text,transaction_id integer);
    CREATE TABLE proof_test(id serial PRIMARY KEY,family_car_id integer REFERENCES family_cars(id));
    INSERT INTO vehicle_intakes(tenant_id,house_id,plate,status) VALUES (1,5,'','waiting'),(1,6,'','waiting')`);
  await new VehicleRegistrationClaims1796500000000().up({ query: (sql: string) => setup.query(sql) } as any);
  const first = await connect(), second = await connect(), legacy = await connect();
  const manager = (client: any): any => ({ queryRunner: { isTransactionActive: true }, query: async (sql: string, args: unknown[]) => (await client.query(sql, args)).rows });
  // Barrier at the attempt, not a process-local lock. PostgreSQL must serialize all contenders.
  let ready = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const contend = async (client: any, intakeId?: number) => {
    await client.query('BEGIN');
    try {
      let familyCarId: number | undefined;
      if (intakeId) await client.query("UPDATE vehicle_intakes SET plate='沪A12345',status='submitted' WHERE id=$1", [intakeId]);
      else {
        familyCarId = (await client.query("INSERT INTO family_cars(tenant_id,house_id,plate,status) VALUES(1,7,'沪a·12345','office') RETURNING id")).rows[0].id;
        await client.query('INSERT INTO proof_test(family_car_id) VALUES($1)', [familyCarId]);
      }
      ready++; if (ready === 3) release(); await barrier;
      await claimVehicleRegistration(manager(client), { tenantId: 1, plate: '沪 A.12345', intakeId, familyCarId });
      await client.query('COMMIT'); return { kind: intakeId ? 'intake' : 'family', id: intakeId ?? familyCarId };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  const results = await Promise.allSettled([contend(first, 1), contend(second, 2), contend(legacy)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(failures.length, 2); failures.forEach(result => assert.equal(result.reason.message, VEHICLE_CLAIM_CONFLICT));
  const rows = (await setup.query('SELECT intake_id,family_car_id FROM vehicle_registration_claims')).rows;
  assert.equal(rows.length, 1);
  const intakes = (await setup.query('SELECT id,plate,status FROM vehicle_intakes ORDER BY id')).rows;
  assert.equal(intakes.filter((row: any) => row.status === 'submitted').length, rows[0].intake_id ? 1 : 0);
  assert.equal(Number((await setup.query('SELECT count(*) AS n FROM family_cars')).rows[0].n), rows[0].family_car_id ? 1 : 0);
  assert.equal(Number((await setup.query('SELECT count(*) AS n FROM proof_test')).rows[0].n), rows[0].family_car_id ? 1 : 0, 'losing legacy create rolls back its proof too');
  // Returned applications retain ownership; a fresh public submission cannot bypass them.
  if (rows[0].intake_id) await setup.query("UPDATE vehicle_intakes SET status='reupload' WHERE id=$1", [rows[0].intake_id]);
  else await setup.query("UPDATE family_cars SET status='returned' WHERE id=$1", [rows[0].family_car_id]);
  await setup.query("INSERT INTO vehicle_intakes(tenant_id,house_id,plate,status) VALUES(1,8,'沪A12345','waiting')");
  await second.query('BEGIN');
  await assert.rejects(claimVehicleRegistration(manager(second), { tenantId: 1, plate: '沪A12345', intakeId: 3 }), new RegExp(VEHICLE_CLAIM_CONFLICT));
  await second.query('ROLLBACK');
  assert.equal(Number((await setup.query('SELECT count(*) AS n FROM vehicle_registration_claims')).rows[0].n), 1);
});
