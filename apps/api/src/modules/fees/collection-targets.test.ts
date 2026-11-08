import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { CollectionTargets1794900000000 } from '../../migrations/1794900000000-CollectionTargets';
import { CollectionTargetGroups1795000000000 } from '../../migrations/1795000000000-CollectionTargetGroups';
import { CollectionTargetFeeCode1795100000000 } from '../../migrations/1795100000000-CollectionTargetFeeCode';
import { CollectionTargetsService } from './collection-targets.service';
import { normalizeMonthCents, targetWarnings } from './collection-targets.util';

test('收费指标：迁移/upsert/唯一约束/月度合计警告', async () => {
  const pg = new PGlite();
  await pg.query(`CREATE TABLE communities(id int PRIMARY KEY,tenant_id int NOT NULL,name text NOT NULL,enabled boolean NOT NULL DEFAULT true)`);
  await pg.query(`INSERT INTO communities(id,tenant_id,name,enabled) VALUES(10,1,'枫桦景苑一期',true),(11,1,'上海新家',true)`);
  const migration = new CollectionTargets1794900000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  const groups = new CollectionTargetGroups1795000000000();
  await groups.up({ query: (sql: string) => pg.query(sql) } as any);
  const feeCode = new CollectionTargetFeeCode1795100000000();
  await feeCode.up({ query: (sql: string) => pg.query(sql) } as any);
  const ds: any = { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows };
  const service = new CollectionTargetsService(ds);
  try {
    assert.deepEqual(await service.list(1, 2026), []);
    const saved: any = await service.upsert(1, 7, { communityIds: [10], year: 2026, annualCents: 1_500_000, monthCents: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000] });
    assert.equal(saved.communityIds.length, 1);
    assert.deepEqual(saved.communityNames, ['枫桦景苑一期']);
    assert.equal(saved.annualCents, 1_500_000);
    assert.equal(saved.monthCents.length, 12);
    assert.equal(saved.feeCode, 'property');
    assert.deepEqual(saved.warnings, ['月度合计 1,200,000 与年度指标 1,500,000 不一致']);
    const updated: any = await service.upsert(1, 8, { communityIds: [10], year: 2026, annualCents: 1_200_000, monthCents: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 100_000] });
    assert.deepEqual(updated.warnings, []);
    const rows: any[] = await ds.query('SELECT COUNT(*)::int AS count FROM collection_targets');
    assert.equal(rows[0].count, 1, '同一租户+小区+年度必须只保留一行');
    const listed: any = await service.list(1, 2026);
    assert.equal(listed.length, 1);
    assert.equal(Number(listed[0].annualCents), 1_200_000);
    await assert.rejects(() => service.upsert(1, 7, { communityIds: [10, 11], year: 2026, annualCents: 1, monthCents: [] }), /重叠/);
    assert.equal(await service.remove(1, Number(saved.id)).then((result: any) => result.deleted), 1);
    assert.deepEqual(normalizeMonthCents([1, null]), [1, null, null, null, null, null, null, null, null, null, null, null]);
    assert.deepEqual(targetWarnings(100, [50, 50]), []);
    const group: any = await service.upsert(1, 7, { communityIds: [10, 11], year: 2026, annualCents: 2_000_000, monthCents: [] });
    assert.equal(group.id > 0, true);
    assert.deepEqual(group.communityIds, [10, 11]);
    assert.deepEqual(group.communityNames, ['枫桦景苑一期', '上海新家']);
    assert.equal(group.feeCode, 'property');
    const groupList: any = await service.list(1, 2026);
    assert.equal(groupList.length, 1);
    assert.deepEqual(groupList[0].communityIds, [10, 11]);
    assert.equal(await service.clearYear(1, 2026).then((result: any) => result.deleted), 1);
    await feeCode.down({ query: (sql: string) => pg.query(sql) } as any);
    await groups.down({ query: (sql: string) => pg.query(sql) } as any);
    await migration.down({ query: (sql: string) => pg.query(sql) } as any);
  } finally {
    await pg.close();
  }
});
