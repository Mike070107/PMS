import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { MisCollectionSms } from '../../entities/mis-collection-sms.entity';
import { CollectionSmsLogService } from './collection-sms-log.service';

/** 在内存 PostgreSQL 里跑真实 SQL，验发送记录与回执推进。 */

async function fixture() {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities: [MisCollectionSms], synchronize: false });
  await (ds as any).buildMetadatas();

  const runner = (connection: any, active = false): any => {
    const qr: any = {
      connection: ds,
      isReleased: false,
      isTransactionActive: active,
      data: {},
      connect: async () => {},
      release: async () => {},
      startTransaction: async () => { await connection.query('BEGIN'); qr.isTransactionActive = true; },
      commitTransaction: async () => { await connection.query('COMMIT'); qr.isTransactionActive = false; },
      rollbackTransaction: async () => { await connection.query('ROLLBACK'); qr.isTransactionActive = false; },
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await connection.query(sql, params);
        if (!structured) return out.rows;
        const result = new QueryResult();
        result.records = out.rows;
        result.raw = out.rows;
        result.affected = out.affectedRows;
        return result;
      },
    };
    qr.broadcaster = new Broadcaster(qr);
    qr.manager = ds.createEntityManager(qr);
    return qr;
  };

  (ds as any).isInitialized = true;
  ds.createQueryRunner = () => runner(pg);
  ds.transaction = ((cb: any) => pg.transaction((tx: any) => cb(runner(tx, true).manager))) as any;

  await pg.exec(`CREATE TABLE mis_collection_sms(
    id serial PRIMARY KEY,
    tenant_id int NOT NULL,
    batch_id int NOT NULL,
    house_key varchar(64) NOT NULL,
    phone_tail varchar(8) NOT NULL,
    content text NOT NULL,
    status varchar(12) NOT NULL DEFAULT 'queued',
    biz_id varchar(80),
    error varchar(200),
    segment_count int NOT NULL DEFAULT 1,
    submitted_at timestamptz,
    delivered_at timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by int,
    updated_by int
  )`);

  const service = new CollectionSmsLogService(ds.getRepository(MisCollectionSms));
  return { pg, service };
}

test('发送记录与回执：提交、送达、失败、未知回执', async () => {
  const { pg, service } = await fixture();
  try {
    const written = await service.record(1, 77, [
      { houseKey: '01:1:1', phoneTail: '0001', content: '尊敬的业主……', segmentCount: 1, status: 'submitted', bizId: 'B1' },
      { houseKey: '01:1:2', phoneTail: '0002', content: '尊敬的业主……', segmentCount: 2, status: 'failed', error: '空号' },
    ], 9);
    assert.equal(written, 2);

    const before = await service.stats(1, 77);
    assert.deepEqual(before, { total: 2, submitted: 1, delivered: 0, failed: 1, segments: 3 });

    const receipt = await service.handleReceipt({ bizId: 'B1', status: 'delivered' });
    assert.equal(receipt.ok, true);
    const after = await service.stats(1, 77);
    assert.equal(after.delivered, 1);
    assert.equal(after.submitted, 0);

    const missing = await service.handleReceipt({ bizId: 'NOT-EXIST', status: 'delivered' });
    assert.equal(missing.ok, false);
  } finally {
    await pg.close();
  }
});

test('只存尾号，不落明文号码', async () => {
  const { pg, service } = await fixture();
  try {
    await service.record(1, 88, [
      { houseKey: '01:1:3', phoneTail: '6621', content: '……', segmentCount: 1, status: 'submitted', bizId: 'B2' },
    ]);
    const rows = await service.byBatch(1, 88);
    assert.equal(rows[0].phoneTail, '6621');
    assert.ok(!JSON.stringify(rows).includes('13800006621'));
  } finally {
    await pg.close();
  }
});
