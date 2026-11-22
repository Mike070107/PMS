import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { BusinessExecutionService } from './business-execution.service';

test('待处理角标按租户和小区计数，忽略过期空单，同笔待补资料只计一次', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE vehicle_intakes(id int, tenant_id int, community_id int, status text, created_at timestamp default now(),
        submitted_at timestamp, reviewed_at timestamp, office_confirmed_version int, transaction_id int, family_car_id int, files jsonb);
      CREATE TABLE business_transactions(tenant_id int, community_id int, service_type text, external_sync_status text, snapshot jsonb);
      INSERT INTO vehicle_intakes(id,tenant_id,community_id,status) VALUES(10,1,1,'waiting'),(11,1,2,'submitted'),(12,2,1,'waiting');
      INSERT INTO vehicle_intakes(id,tenant_id,community_id,status,created_at) VALUES(13,1,1,'waiting',now()-interval '25 hours');
      INSERT INTO business_transactions VALUES (1,1,'parking_monthly','awaiting_docs','{"intake":{"id":10}}'),
        (1,1,'parking_monthly','manual','{}'),(1,1,'parking_monthly','synced','{}'),(2,1,'parking_monthly','manual','{}');`);
    const service = Object.assign(Object.create(BusinessExecutionService.prototype), {
      txnRepo: { query: async (sql:string, params:unknown[]) => (await db.query(sql,params)).rows },
    });
    assert.deepEqual(await service.pendingCount(1, [1]), {count:2});
    assert.deepEqual(await service.pendingCount(1, null), {count:3});
    assert.deepEqual(await service.pendingCount(1, []), {count:0});
  } finally { await db.close(); }
});
