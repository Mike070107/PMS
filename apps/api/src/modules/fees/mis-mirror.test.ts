import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorFailureCount1794600000000 } from '../../migrations/1794600000000-MisMirrorFailureCount';
import { MisMirrorOwnerReportFields1795600000000 } from '../../migrations/1795600000000-MisMirrorOwnerReportFields';
import { MisMirrorChargeStandard1795700000000 } from '../../migrations/1795700000000-MisMirrorChargeStandard';
import { MisMirrorService } from './mis-mirror.service';

async function fixture() {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  const health = new MisMirrorFailureCount1794600000000();
  await health.up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorOwnerReportFields1795600000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorChargeStandard1795700000000().up({ query: (sql: string) => pg.query(sql) } as any);
  const dataSource: any = { query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows };
  const misFees: any = {
    residentialScope: async () => [{ id: 1, name: '枫桦苑一期', offices: ['01'] }],
    collectionCommunities: async () => [{ id: 1, name: '枫桦苑一期', offices: ['01'] }],
  };
  const service: any = new MisMirrorService(dataSource, misFees, {} as any);
  await pg.query(`INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,initialized_at) VALUES(1,'bill',now(),now())`);
  const add = (id: number, sId: number, zhId: number, amount: number, paid: string | null = null, refund: string | null = null, feeName = '管理费') => pg.query(
    `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,zh_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,source_updated_at)
     VALUES($1,'01',$2,$3,$4,$5,$6,'01',$7,'202610',$8,$9,$10,'现金',now())`,
    [id, sId, zhId, `业主${zhId}`, String(sId), `枫桦苑一期${sId}号`, feeName, amount, paid, refund],
  );
  await add(1, 1, 1, 10000);
  await add(2, 1, 1, 20000);
  await add(3, 2, 2, 150000);
  await add(4, 3, 3, 300000);
  await add(5, 4, 4, 600000);
  await add(6, 5, 5, 50000, '2026-11-08');
  await add(7, 6, 6, 30000, null, '2026-11-08');
  await add(8, 1, 1, -500);
  await add(9, 8, 8, 10000, '2026-11-08', '2026-11-08');
  return { pg, service, migration, health };
}

test('业主报表字段迁移可重复执行/回退，旧行保持未知且不改变原有数据', async () => {
  const pg = new PGlite();
  const runner = { query: (sql: string) => pg.query(sql) } as any;
  const migration = new MisMirrorOwnerReportFields1795600000000();
  try {
    await new MisMirror1794500000000().up(runner);
    await pg.query(`INSERT INTO mis_mirror_owner(zh_id,s_id,name) VALUES(1,10,'合成旧住户')`);
    await migration.up(runner);
    await migration.up(runner);
    const { rows } = await pg.query(`SELECT name,owner_note,move_in_date,billing_start_date FROM mis_mirror_owner WHERE zh_id=1`);
    assert.deepEqual(rows, [{ name: '合成旧住户', owner_note: null, move_in_date: null, billing_start_date: null }]);
    await migration.down(runner);
    await migration.down(runner);
    assert.deepEqual((await pg.query(`SELECT zh_id,s_id,name FROM mis_mirror_owner`)).rows, [{ zh_id: 1, s_id: 10, name: '合成旧住户' }]);
    const columns = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name='mis_mirror_owner' AND column_name IN ('owner_note','move_in_date','billing_start_date')`);
    assert.equal(columns.rows.length, 0);
  } finally { await pg.close(); }
});

test('全量业主镜像保留原始说明和民用日期，不猜测空置/退户状态或填补缺失日期', async () => {
  const { pg, service } = await fixture();
  const owners = [
    { zhId: '701', sId: '1', name: '合成住户', ownerNote: '新进户', moveInDate: '2020-01-01', billingStartDate: '2020-02-01' },
    { zhId: '702', sId: '1', name: '合成历史住户', ownerNote: '历史说明原文' },
    { zhId: '703', sId: '2', name: null, ownerNote: null, moveInDate: null, billingStartDate: null },
  ];
  let ownerQueries = 0;
  const run = async (sql: string, params?: any[]) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
    if (sql.includes('pg_advisory_unlock')) return [];
    return (await pg.query(sql, params)).rows;
  };
  service.dataSource = {
    query: run,
    transaction: (work: any) => pg.transaction(async (tx) => work({
      query: async (sql: string, params?: any[]) => (await tx.query(sql, params)).rows,
    })),
  };
  service.misFees = { mirrorRead: async (sql: string) => {
    if (sql.includes('FROM dbo.业主表')) {
      ownerQueries++;
      assert.match(sql, /说明 AS ownerNote/, '不能丢失旧报表按业主说明筛选的源字段');
      assert.match(sql, /CONVERT\(varchar\(10\),进户日期,23\) AS moveInDate/);
      assert.match(sql, /CONVERT\(varchar\(10\),开始收费日期,23\) AS billingStartDate/);
      return { recordsets: [owners] };
    }
    return { recordsets: [[]] };
  } };
  service.syncSmallDimensions = async () => undefined;
  service.syncExtraMirrors = async () => ({ rows: 0 });
  try {
    await service.reloadAll(1);
    const read = () => pg.query<{ zh_id: number; owner_note: string | null; move_in_date: string | null; billing_start_date: string | null }>(`SELECT zh_id,owner_note,move_in_date::text,billing_start_date::text FROM mis_mirror_owner ORDER BY zh_id`);
    assert.deepEqual((await read()).rows, [
      { zh_id: 701, owner_note: '新进户', move_in_date: '2020-01-01', billing_start_date: '2020-02-01' },
      { zh_id: 702, owner_note: '历史说明原文', move_in_date: null, billing_start_date: null },
      { zh_id: 703, owner_note: null, move_in_date: null, billing_start_date: null },
    ]);
    owners[0].ownerNote = '原始说明变更';
    await service.reloadAll(1);
    assert.equal(ownerQueries, 2);
    assert.equal((await read()).rows[0].owner_note, '原始说明变更', '重复重灌必须保留最新源值');
  } finally { await pg.close(); }
});

test('业主报表迁移缺失时重灌明确返回 503，且不读取 MIS 或改动已有镜像', async () => {
  const { pg, service } = await fixture();
  let sourceReads = 0;
  let unlocks = 0;
  service.dataSource.query = async (sql: string, params?: any[]) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
    if (sql.includes('pg_advisory_unlock')) { unlocks++; return []; }
    return (await pg.query(sql, params)).rows;
  };
  service.misFees.mirrorRead = async () => { sourceReads++; throw new Error('不应访问 MIS'); };
  try {
    await pg.query(`INSERT INTO mis_mirror_owner(zh_id,name) VALUES(901,'合成保留住户')`);
    await new MisMirrorOwnerReportFields1795600000000().down({ query: (sql: string) => pg.query(sql) } as any);
    const before = (await pg.query('SELECT * FROM mis_mirror_owner')).rows;
    await assert.rejects(service.reloadAll(1), (error: any) => error.getStatus?.() === 503 && error.message.includes('1795600000000'));
    assert.equal(sourceReads, 0);
    assert.equal(unlocks, 1, '迁移未就绪也应释放同步锁');
    assert.deepEqual((await pg.query('SELECT * FROM mis_mirror_owner')).rows, before);
    assert.equal((await pg.query('SELECT zj_id FROM mis_mirror_bill')).rows.length, 9);
  } finally { await pg.close(); }
});

test('重灌结构检查保留数据库权限/连接错误，不伪装成缺迁移或继续读取 MIS', async () => {
  const failure = Object.assign(new Error('synthetic permission denied'), { code: '42501' });
  let sourceReads = 0;
  let unlocks = 0;
  const service = new MisMirrorService({ query: async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
    if (sql.includes('pg_advisory_unlock')) { unlocks++; return []; }
    throw failure;
  } } as any, { mirrorRead: async () => { sourceReads++; throw failure; } } as any, {} as any);
  await assert.rejects(service.reloadAll(1), (error) => error === failure);
  assert.equal(sourceReads, 0);
  assert.equal(unlocks, 1);
});

test('业主源读取失败或新日期落库失败均保留原维度、账单及成功水位', async () => {
  const { pg, service } = await fixture();
  const sourceFailure = new Error('synthetic owner source unavailable');
  let failSource = true;
  let unlocks = 0;
  service.dataSource = {
    query: async (sql: string, params?: any[]) => {
      if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
      if (sql.includes('pg_advisory_unlock')) { unlocks++; return []; }
      return (await pg.query(sql, params)).rows;
    },
    transaction: (work: any) => pg.transaction(async (tx) => work({
      query: async (sql: string, params?: any[]) => (await tx.query(sql, params)).rows,
    })),
  };
  service.misFees.mirrorRead = async (sql: string) => {
    if (sql.includes('FROM dbo.楼表')) return { recordsets: [[{ lId: '502', officeCode: '01' }]] };
    if (sql.includes('FROM dbo.室表')) return { recordsets: [[{ sId: '502', lId: '502', roomNo: '新合成室' }]] };
    if (sql.includes('FROM dbo.业主表')) {
      if (failSource) throw sourceFailure;
      return { recordsets: [[{ zhId: '902', sId: '502', name: '新合成住户', ownerNote: '新进户', moveInDate: 'invalid-civil-day' }]] };
    }
    if (sql.includes('FROM dbo.WYDJ')) return { recordsets: [[]] };
    throw new Error('失败后的同步步骤不应执行');
  };
  const snapshot = async () => Promise.all([
    pg.query('SELECT * FROM mis_mirror_building ORDER BY l_id'),
    pg.query('SELECT * FROM mis_mirror_room ORDER BY s_id'),
    pg.query('SELECT * FROM mis_mirror_owner ORDER BY zh_id'),
    pg.query('SELECT * FROM mis_mirror_bill ORDER BY zj_id'),
    pg.query('SELECT * FROM mis_sync_state ORDER BY tenant_id,source_table'),
  ]).then((results) => results.map((result) => result.rows));
  try {
    await pg.query(`INSERT INTO mis_mirror_building(l_id,office_code) VALUES(501,'01')`);
    await pg.query(`INSERT INTO mis_mirror_room(s_id,l_id,room_no) VALUES(501,501,'原合成室')`);
    await pg.query(`INSERT INTO mis_mirror_owner(zh_id,s_id,name,owner_note,move_in_date) VALUES(901,501,'原合成住户','原始说明','2020-01-01')`);
    const before = await snapshot();
    await assert.rejects(service.reloadAll(1), (error) => error === sourceFailure);
    assert.deepEqual(await snapshot(), before, '源读取失败不能开始替换维度');
    failSource = false;
    await assert.rejects(service.reloadAll(1), /invalid input syntax for type date/);
    assert.deepEqual(await snapshot(), before, '日期落库失败应回滚三张维度表，且不推进账单同步水位');
    assert.equal(unlocks, 2);
  } finally { await pg.close(); }
});

test('镜像迁移可 up/down，金额分档按户聚合后分档', async () => {
  const { pg, service, migration, health } = await fixture();
  try {
    const result: any = await service.residential({ view: 'amount-brackets' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.deepEqual(result.buckets.map((row: any) => [row.key, row.count, row.amountCents]), [
      ['le500', 1, 30000],
      ['500to2000', 1, 150000],
      ['2000to5000', 1, 300000],
      ['gt5000', 1, 600000],
    ]);
    assert.deepEqual(result.total, { count: 4, amountCents: 1080000 });
    assert.equal(result.source, 'mirror');
    const dashboard: any = await service.residential({ view: 'dashboard' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(dashboard.summary.unpaidCents, 1080000);
    assert.equal(dashboard.summary.unpaidHouses, 4);
    assert.equal(dashboard.summary.adjustmentCount, 1);
    assert.equal(dashboard.summary.adjustmentCents, -500);
    assert.equal(dashboard.summary.netPaidCents, dashboard.summary.paidCents - 500);
    const houses: any = await service.residential({ view: 'households', status: 'unpaid' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(houses.total, 4);
    assert.equal(houses.rows.length, 4);
    assert.equal(houses.rows[0].amountCents, 30000);
    const today: any = await service.today({ date: '2026-11-08' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(today.paidCents, 50000);
    assert.equal(today.refundedCents, 40000);
    assert.deepEqual(today.byFee.map((row: any) => [row.feeCode, row.feeName]), [['property', '物业费']]);
    const details: any = await service.todayDetails({ date: '2026-11-08', category: 'property' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(details.total, 1);
    assert.equal(details.rows[0].paidDate, '2026-11-08');
    assert.equal(details.rows[0].channel, '现金');
    assert.equal(details.rows[0].billCount, 1);
    // 收款日 11-08、登记日 11-09：明细必须按收款日归到 11-08，不能按登记日漂到 11-09。
    await pg.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,zh_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,source_updated_at)
       VALUES(10,'01',7,7,'业主7','7','枫桦苑一期7号','01','管理费','202610',12345,'2026-11-08',NULL,'现金','2026-11-09T10:00:00+08:00')`,
    );
    const detailsSameDay: any = await service.todayDetails({ date: '2026-11-08', category: 'property' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(detailsSameDay.total, 2);
    assert.equal(detailsSameDay.groupCount, 2);
    assert.ok(detailsSameDay.rows.every((row: any) => row.paidDate === '2026-11-08'));
    const recorded = detailsSameDay.rows.find((row: any) => row.billCount === 1 && row.amountCents === 12345);
    assert.equal(recorded.recordedAt, '2026-11-09T10:00:00+08:00');
    const detailsNextDay: any = await service.todayDetails({ date: '2026-11-09', category: 'property' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(detailsNextDay.total, 0);
    const todayAfter: any = await service.today({ date: '2026-11-08' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(detailsSameDay.total, todayAfter.byFee.reduce((sum: number, row: any) => sum + row.billCount, 0));
    assert.equal(detailsSameDay.rows.reduce((sum: number, row: any) => sum + row.amountCents, 0), todayAfter.paidCents);
    const trend: any = await service.residential({ view: 'trend', paidFrom: '2026-11-01', paidTo: '2026-11-08', bucket: 'day' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(trend.rows[0].day, '2026-11-08');
    assert.equal(trend.rows[0].chargedCents, 72345);
    assert.equal(trend.rows[0].refundedCents, 10000);
    assert.equal(trend.rows[0].netCents, 62345);
    const detail: any = await service.residential({ view: 'detail', houseKeys: ['01:7:7'], status: 'paid' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any);
    assert.equal(detail.rows.length, 1);
    assert.equal(detail.rows[0].houseKey, '01:7:7');
    assert.equal(detail.rows[0].amountCents, 12345);
    assert.equal(detail.rows[0].paidAt, '2026-11-08');
    await health.down({ query: (sql: string) => pg.query(sql) } as any);
    await migration.down({ query: (sql: string) => pg.query(sql) } as any);
  } finally { await pg.close(); }
});

test('镜像未初始化时明确报错，不返回全 0 假装有数据', async () => {
  const pg = new PGlite();
  const migration = new MisMirror1794500000000();
  await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  try {
    const service: any = new MisMirrorService(
      { query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows } as any,
      { residentialScope: async () => [{ id: 1, name: '枫桦苑一期', offices: ['01'] }] } as any,
      {} as any,
    );
    await assert.rejects(() => service.residential({ view: 'dashboard' }, { id: 1, tenantId: 1 }, { scopeAll: true } as any), /镜像尚未完成初始化/);
  } finally { await pg.close(); }
});

test('增量同步主谓词用 ZJ_ID keyset，updatedate 只做 15 分钟补漏，不再生成 WHERE AND', async () => {
  const service: any = Object.create(MisMirrorService.prototype);
  const state = { tenant_id: 1, source_table: 'bill', initialized_at: new Date(), last_updated_at: new Date('2026-11-07T15:34:00+08:00'), last_id: 654544 };
  const sqls: string[] = [];
  service.dataSource = {
    async query(sql: string) {
      sqls.push(String(sql));
      if (/SELECT \* FROM mis_sync_state/.test(sql) && /source_table='bill_sweep'/.test(sql)) return [];
      if (/SELECT \* FROM mis_sync_state/.test(sql)) return [state];
      return [];
    },
  };
  service.misFees = { mirrorRead: async (sql: string) => { sqls.push(String(sql)); return { recordsets: [[]] }; } };
  await service.syncBills(1);
  const newSql = sqls.find((sql) => sql.includes('WHERE w.ZJ_ID > @lastId'));
  const sweepSql = sqls.find((sql) => sql.includes('WHERE w.updatedate >'));
  assert.ok(newSql, '主增量必须走 ZJ_IDkeyset');
  assert.ok(sweepSql, '旧行补漏走 updatedate');
  assert.ok(!sqls.some((sql) => /WHERE\s+AND/.test(sql)), '不得生成 WHERE AND');
});
