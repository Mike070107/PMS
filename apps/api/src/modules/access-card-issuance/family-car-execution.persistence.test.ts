import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { FamilyCarExecutionCheck1796400000000 } from '../../migrations/1796400000000-FamilyCarExecutionCheck';

// Isolated PostgreSQL only. No AppModule, environment loading or live gateway calls.
test('开通查重迁移可重复，保留历史记录与原任务；回滚不删列', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE family_cars(id integer PRIMARY KEY, plate text, status text, registration_operation_id integer);
    INSERT INTO family_cars VALUES (1, 'SYNTHETIC', 'office', 71), (2, 'SYNTHETIC_ACTIVE', 'active', 72)`);
  const runner: any = { query: (sql: string) => db.query(sql) };
  const migration = new FamilyCarExecutionCheck1796400000000();
  await migration.up(runner);
  await migration.up(runner);
  assert.deepEqual((await db.query('SELECT * FROM family_cars ORDER BY id')).rows, [
    { id: 1, plate: 'SYNTHETIC', status: 'office', registration_operation_id: 71, duplicate_check_query_id: null, registration_term: null },
    { id: 2, plate: 'SYNTHETIC_ACTIVE', status: 'active', registration_operation_id: 72, duplicate_check_query_id: null, registration_term: null },
  ]);
  await db.query('UPDATE family_cars SET duplicate_check_query_id=$1 WHERE id=$2', [80, 1]);
  assert.equal((await db.query<{ duplicate_check_query_id: number }>('SELECT duplicate_check_query_id FROM family_cars WHERE id=1')).rows[0].duplicate_check_query_id, 80);
  await assert.rejects(migration.down(), /Retain/);
  assert.equal((await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM family_cars')).rows[0].n, 2);
});
