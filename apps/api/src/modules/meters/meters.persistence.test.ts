import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { entities, Meter, MeterCharge, MeterOcrSample, MeterReading } from '../../entities';
import { UserRole } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';
import { MetersService } from './meters.service';
import { Meters1792900000000 } from '../../migrations/1792900000000-Meters';
import { MeterLearning1792900000001 } from '../../migrations/1792900000001-MeterLearning';

/**
 * 在内存 PostgreSQL 里跑真实迁移和真实 SQL/事务，验证「读数→用量→账单→收款」这条链。
 * 不连接任何业务数据库。
 */
async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE communities(id serial PRIMARY KEY, tenant_id int, name text);
    CREATE TABLE houses(id serial PRIMARY KEY, tenant_id int, building_id int, room_no text);
    CREATE TABLE buildings(id serial PRIMARY KEY, tenant_id int, community_id int, building_no text);
    CREATE TABLE users(id serial PRIMARY KEY, tenant_id int, name text, phone text);
    INSERT INTO users(id, tenant_id, name) VALUES (7, 1, '张师傅');
  `);
  const ds = new DataSource({ type: 'postgres', entities, synchronize: false });
  await (ds as any).buildMetadatas();
  const runner = (connection: any, active = false): any => {
    const qr: any = {
      connection: ds,
      isReleased: false,
      isTransactionActive: active,
      data: {},
      connect: async () => undefined,
      release: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
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
  ds.transaction = ((callback: any) =>
    pg.transaction((tx: any) => callback(runner(tx, true).manager))) as any;

  await new Meters1792900000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MeterLearning1792900000001().up({ query: (sql: string) => pg.query(sql) } as any);
  await pg.query(
    `INSERT INTO meters(tenant_id, meter_no, meter_type, name, unit, integer_digits, decimal_digits,
       multiplier, unit_price_cents, initial_reading, initial_reading_at, last_reading_value,
       last_reading_at, status, qr_token, billing_enabled)
     VALUES(1,'W-001','water','1号楼总表','m³',5,0,1,420,2400,'2026-09-01T00:00:00+08:00',2400,'2026-09-01T00:00:00+08:00','active','tok-1',true)`,
  );
  const storage: any = { toDisplayUrl: (url: string) => url || '' };
  const ocr: any = {};
  const service = new MetersService(
    ds.getRepository(Meter),
    ds.getRepository(MeterReading),
    ds.getRepository(MeterCharge),
    ds.getRepository(MeterOcrSample),
    {} as any,
    {} as any,
    {} as any,
    { findOne: async () => ({ name: '张师傅' }) } as any,
    ds,
    storage,
    ocr,
    { isConfigured: () => false } as any,
  );
  return { pg, ds, service };
}

const user = { id: 7, tenantId: 1, role: UserRole.STAFF } as any;
const access = { scopeAll: true, communityIds: null } as ResolvedAccess;

function reading(value: number, at: string, requestId: string) {
  return {
    readingValue: value,
    readAt: at,
    photoKey: 'uploads/meter/test.jpg',
    clientRequestId: requestId,
    source: 'photo' as const,
  };
}

test('真实迁移/SQL：首次抄表→账单→第二次用量→幂等重试不重复出账', async () => {
  const { pg, service } = await fixture();
  try {
    const first = await service.createReading(
      1,
      reading(2410, '2026-10-01T09:00:00+08:00', 'req-1'),
      user,
      access,
    );
    assert.equal(first.reading.status, 'pending');
    assert.equal(first.charge, null);
    assert.equal(first.meter.lastReadingValue, 2400);
    const firstReviewed = await service.reviewReading(first.reading.id, {}, user, access);
    assert.equal(firstReviewed.reading.readingValue, 2410);
    assert.equal(firstReviewed.reading.previousValue, 2400);
    assert.equal(firstReviewed.reading.usageValue, 10);
    assert.equal(firstReviewed.charge?.amountCents, 4200);
    assert.equal(firstReviewed.charge?.period, '2026-10');
    assert.equal(firstReviewed.meter.lastReadingValue, 2410);

    const second = await service.createReading(
      1,
      reading(2415, '2026-10-05T09:00:00+08:00', 'req-2'),
      user,
      access,
    );
    const secondReviewed = await service.reviewReading(second.reading.id, {}, user, access);
    assert.equal(secondReviewed.reading.usageValue, 5);
    assert.equal(secondReviewed.charge?.amountCents, 2100);
    assert.equal(secondReviewed.charge?.receivableCents, 2100);

    const retry = await service.createReading(
      1,
      reading(2415, '2026-10-05T09:00:00+08:00', 'req-2'),
      user,
      access,
    );
    assert.equal(retry.reading.id, second.reading.id);
    assert.equal((await pg.query<any>('SELECT count(*)::int AS n FROM meter_readings')).rows[0].n, 2);
    assert.equal((await pg.query<any>('SELECT count(*)::int AS n FROM meter_charges')).rows[0].n, 2);

    const charges = await service.listCharges({ period: '2026-10' }, user, access);
    assert.equal(charges.total, 2);
    assert.equal(charges.totals.receivable, 6300);
    assert.equal(charges.totals.outstanding, 6300);

    const meters = await service.listMeters({}, user, access);
    assert.equal(meters.total, 1);
    assert.equal(meters.rows[0].lastReadingValue, 2415);
    assert.equal(meters.rows[0].unpaidCents, 6300);
    const summary = await service.summary({ period: '2026-10' }, user, access);
    assert.equal(summary.readings.meters_read, 1);
    assert.equal(summary.charges.outstanding, 6300);
  } finally {
    await pg.close();
  }
});

test('真实迁移/SQL：抄错不能当归零、补录时间不能早于最近一次、收款后不能改数', async () => {
  const { pg, service } = await fixture();
  try {
    const first = await service.createReading(1, reading(2410, '2026-10-01T09:00:00+08:00', 'r1'), user, access);
    await service.reviewReading(first.reading.id, {}, user, access);
    await assert.rejects(
      service.createReading(1, reading(2400, '2026-10-06T09:00:00+08:00', 'r2'), user, access),
      /小于上次/,
    );
    await assert.rejects(
      service.createReading(1, reading(2420, '2026-09-20T09:00:00+08:00', 'r3'), user, access),
      /早于最近一次抄表/,
    );

    const latest = await service.createReading(1, reading(2420, '2026-10-08T09:00:00+08:00', 'r4'), user, access);
    const latestReviewed = await service.reviewReading(latest.reading.id, {}, user, access);
    assert.equal(latestReviewed.reading.usageValue, 10);

    await service.payCharge(latestReviewed.charge!.id, { amountCents: 4200, method: 'cash' }, user, access);
    await assert.rejects(
      service.updateReading(latestReviewed.reading.id, { readingValue: 2421 }, user, access),
      /已收款/,
    );
    await assert.rejects(
      service.payCharge(latestReviewed.charge!.id, { amountCents: 1 }, user, access),
      /已结清/,
    );

    const before = await service.meterDetail(1, user, access);
    assert.equal(before.stats.unpaidCents, 4200);
    assert.equal(before.charges[0].paidCents, 4200);
  } finally {
    await pg.close();
  }
});

test('真实迁移/SQL：后台纠正读数会自动落学习样本，可标记进训练集', async () => {
  const { pg, service } = await fixture();
  try {
    const created = await service.createReading(1, reading(2410, '2026-10-01T09:00:00+08:00', 's1'), user, access);
    await service.reviewReading(created.reading.id, { readingValue: 2420, reviewNote: '识别少了一位' }, user, access);

    const list = await service.listOcrSamples({}, user, access);
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].predictedValue, '2410.000');
    assert.equal(list.rows[0].correctedValue, '2420.000');
    assert.equal(list.rows[0].status, 'candidate');

    const marked = await service.updateOcrSample(list.rows[0].id, { status: 'training' }, user, access);
    assert.equal(marked.status, 'training');

    const rows = await pg.query(`SELECT predicted_value, corrected_value FROM meter_ocr_samples`);
    assert.equal(rows.rows.length, 1);
  } finally {
    await pg.close();
  }
});

test('真实迁移/SQL：作废最近一次抄表会回退表头读数并作废未收账单', async () => {
  const { pg, service } = await fixture();
  try {
    const first = await service.createReading(1, reading(2410, '2026-10-01T09:00:00+08:00', 'v1'), user, access);
    await service.reviewReading(first.reading.id, {}, user, access);
    const second = await service.createReading(1, reading(2420, '2026-10-06T09:00:00+08:00', 'v2'), user, access);
    await service.reviewReading(second.reading.id, {}, user, access);
    await service.updateReading(second.reading.id, { status: 'void', reviewNote: '抄错表' }, user, access);
    const detail = await service.meterDetail(1, user, access);
    assert.equal(detail.meter.lastReadingValue, 2410);
    assert.equal(detail.readings.filter((row) => row.status === 'void').length, 1);
    assert.equal(detail.charges[0].status, 'void');
  } finally {
    await pg.close();
  }
});
