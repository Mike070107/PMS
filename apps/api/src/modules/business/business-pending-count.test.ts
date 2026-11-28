import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { BusinessExecutionService } from './business-execution.service';

test('待处理角标按租户和小区计数，包含待补资料和开通受阻，同笔待补资料只计一次', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE vehicle_intakes(id int, tenant_id int, community_id int, status text, created_at timestamp default now(),
        submitted_at timestamp, reviewed_at timestamp, office_confirmed_version int, transaction_id int, family_car_id int, files jsonb);
      ALTER TABLE vehicle_intakes ADD kind text, ADD log jsonb DEFAULT '[]';
      CREATE TABLE houses(id int,building_id int);
      CREATE TABLE buildings(id int,community_id int);
      CREATE TABLE family_cars(tenant_id int,house_id int,status text);
      INSERT INTO houses VALUES(1,10),(2,20);
      INSERT INTO buildings VALUES(10,1),(20,2);
      INSERT INTO family_cars VALUES(1,1,'opening'),(1,2,'manager'),(2,1,'opening'),(1,1,'active');
      CREATE TABLE parking_operations(tenant_id int,database text,status text,expected jsonb);
      INSERT INTO parking_operations VALUES(1,'plate-review','review','{"communityIds":[1,2]}');
      CREATE TABLE business_transactions(tenant_id int, community_id int, service_type text, external_sync_status text, snapshot jsonb);
      INSERT INTO vehicle_intakes(id,tenant_id,community_id,status) VALUES(10,1,1,'waiting'),(11,1,2,'submitted'),(12,2,1,'waiting');
      INSERT INTO vehicle_intakes(id,tenant_id,community_id,status,created_at) VALUES(13,1,1,'waiting',now()-interval '25 hours');
      INSERT INTO business_transactions VALUES (1,1,'parking_monthly','awaiting_docs','{"intake":{"id":10}}'),
        (1,1,'parking_monthly','manual','{}'),(1,1,'parking_monthly','synced','{}'),(2,1,'parking_monthly','manual','{}');`);
    const service = Object.assign(Object.create(BusinessExecutionService.prototype), {
      txnRepo: { query: async (sql:string, params:unknown[]) => (await db.query(sql,params)).rows },
    });
    assert.deepEqual(await service.pendingCount(1, [1]), {count:4});
    assert.deepEqual(await service.pendingCount(1, null), {count:7});
    assert.deepEqual(await service.pendingCount(1, [1], {intakes:false,families:true,transactions:false,reviews:false}), {count:1});
    assert.deepEqual(await service.pendingCount(1, []), {count:0});
  } finally { await db.close(); }
});
