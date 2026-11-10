import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import ExcelJS from 'exceljs';
import { entities, FeeBill, FeeStandard, House, Community, User } from '../../entities';
import { FeesService } from './fees.service';
import { FeesController } from './fees.controller';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorP4Extras1795500000000 } from '../../migrations/1795500000000-MisMirrorP4Extras';
import { UserRole } from '../../common/enums';

/** 生产 2026-10 MIS 实收基准（分 / 行数）。 */
const MIS_BASELINE = [
  { office: '01', total: 15_246_910, count: 992, method: '微信', cashier: '胡美君' },
  { office: '02', total: 15_314_220, count: 844, method: '微信', cashier: '胡美君' },
  { office: '03', total: 16_243_810, count: 837, method: '现金', cashier: '伍庆中' },
  { office: '04', total: 46_508_500, count: 362, method: '转账', cashier: '刘微微' },
];
const MIS_TOTAL = 93_313_440;
const MIS_ROWS = 3_035;

async function fixture(options: { withMis?: boolean; pmsCommunityId?: number; pmsAmount?: number } = {}) {
  const pg = new PGlite();
  const ds = new DataSource({ type: 'postgres', entities, synchronize: false });
  await (ds as any).buildMetadatas();
  const runner = (connection: any, active = false): any => {
    const qr: any = {
      connection: ds, isReleased: false, isTransactionActive: active, data: {},
      connect: async () => {}, release: async () => {},
      query: async (sql: string, params: any[] = [], structured = false) => {
        const out = await connection.query(sql, params);
        if (!structured) return out.rows;
        const result = new QueryResult();
        result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows;
        return result;
      },
    };
    qr.broadcaster = new Broadcaster(qr);
    qr.manager = ds.createEntityManager(qr);
    return qr;
  };
  (ds as any).isInitialized = true;
  ds.createQueryRunner = () => runner(pg);
  ds.transaction = ((callback: any) => pg.transaction((tx: any) => callback(runner(tx, true).manager))) as any;
  const table = ds.getMetadata(FeeBill);
  const columns = table.columns.map((column) => {
    const type = column.type === Number ? 'integer' : column.type === String ? 'varchar' : column.type;
    return `"${column.databaseName}" ${column.isPrimary ? 'serial PRIMARY KEY' : type}${column.isNullable || column.isPrimary ? '' : ' NOT NULL'}${column.databaseName === 'created_at' || column.databaseName === 'updated_at' ? ' DEFAULT now()' : ''}`;
  });
  await pg.exec(`CREATE TABLE fee_bills(${columns.join(',')});
    CREATE TABLE communities(id int,tenant_id int,name text);
    INSERT INTO communities VALUES(1,1,'枫桦景苑一期'),(2,1,'枫桦景苑二期'),(9,1,'馨香臣寓'),(16,1,'上海新家');
    CREATE TABLE buildings(id int,tenant_id int,community_id int,road_name text,lane text,building_no text);
    INSERT INTO buildings VALUES(1,1,1,'剑川路','198','1'),(2,1,2,'永德路','228','50'),(3,1,9,'颛桥路','1','1'),(4,1,16,'通海路','328','1');
    CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text,full_address text);
    INSERT INTO houses VALUES(1,1,1,'101','剑川路198弄1号101'),(2,1,2,'202','永德路228弄50号202'),(3,1,3,'101','颛桥路1弄1号101'),(4,1,4,'101','通海路328弄1号101');
    CREATE TABLE users(id int,tenant_id int,name text,phone text,house_id int,role text);`);
  const service = new FeesService(
    ds.getRepository(FeeBill), ds.getRepository(FeeStandard), ds.getRepository(House),
    ds.getRepository(Community), ds.getRepository(User), ds, {} as any,
  );
  const user = { id: 1, tenantId: 1, role: UserRole.STAFF } as never;
  const scopeAll = { scopeAll: true } as never;
  const pmsCommunityId = options.pmsCommunityId ?? 9;
  const pmsAmount = options.pmsAmount ?? 1_000_000;
  const pmsHouseId = pmsCommunityId === 2 ? 2 : 3;
  await pg.query(
    `INSERT INTO fee_bills(tenant_id,community_id,house_id,owner_id,owner_name,fee_code,fee_name,period,amount_cents,status,paid_at,payment_method,receipt_no,cashier,source,created_by,updated_by)
     VALUES(1,$1,$2,NULL,'PMS业主','rent','房租','202610',$3,'paid','2026-10-05T10:00:00+08:00','现金','PMS001','PMS收费员','manual',1,1)`,
    [pmsCommunityId, pmsHouseId, pmsAmount],
  );
  let withMis = options.withMis !== false;
  if (withMis) {
    try {
      await new MisMirror1794500000000().up({ query: (sql: string) => pg.query(sql) } as any);
      await new MisMirrorBillNature1795300000000().up({ query: (sql: string) => pg.query(sql) } as any);
      await new MisMirrorP4Extras1795500000000().up({ query: (sql: string) => pg.query(sql) } as any);
    } catch {
      withMis = false;
    }
  }
  if (withMis) {
    await pg.query(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name) VALUES('01','管理费'),('04','泊位费')`);
    let nextId = 1;
    for (const [index, item] of MIS_BASELINE.entries()) {
      const base = Math.floor(item.total / item.count);
      const remainder = item.total - base * (item.count - 1);
      await pg.query(
        `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,nature_code,period,
           amount_cents,paid_date,refund_date,payment_method,cashier,receipt_warehouse_no,invoice_no,source_updated_at)
         SELECT $1+idx, $2, $3+idx, '旧业主', '101', '旧系统地址' || idx, '01', '管理费', '01', '202610',
                CASE WHEN idx = $4 THEN $5::bigint ELSE $6::bigint END, '2026-10-05', NULL, $7, $8, 'WH-' || idx, 'IV-' || idx, now()
           FROM generate_series(1,$4) idx`,
        [nextId, item.office, index * 100_000, item.count, remainder, base, item.method, item.cashier],
      );
      nextId += item.count;
    }
  }
  return { pg, ds, service, user, scopeAll, withMis, pmsAmount };
}

function controllerFor(service: FeesService) {
  return new FeesController(
    service as any,
    { registerCollectionPrint: async () => ({}) } as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

test('收费报表 summary：PMS + 旧 MIS 实收合并，byCommunity 带 source/officeCode，totals=两源之和', async () => {
  const { pg, service, user } = await fixture();
  try {
    const result: any = await service.feeReport({ from: '2026-10-01', to: '2026-10-31' }, user);
    assert.equal(result.totals.netCents, MIS_TOTAL + 1_000_000);
    assert.equal(result.totals.receiptCount, MIS_ROWS + 1);
    assert.equal(result.totals.itemCount, MIS_ROWS + 1);
    assert.equal(result.totals.chargedCents, MIS_TOTAL + 1_000_000);
    assert.equal(result.totals.refundedCents, 0);
    const misCommunities = result.byCommunity.filter((row: any) => row.source === 'mis');
    assert.deepEqual(
      misCommunities.map((row: any) => [row.officeCode, row.communityId, row.amountCents]).sort(),
      [
        ['01', 1, 15_246_910],
        ['02', 2, 15_314_220],
        ['03', 2, 16_243_810],
        ['04', 16, 46_508_500],
      ].sort(),
    );
    assert.ok(misCommunities.every((row: any) => row.communityName.includes('（旧系统）')));
    const pmsRow = result.byCommunity.find((row: any) => row.source === 'pms');
    assert.deepEqual([pmsRow.communityId, pmsRow.amountCents], [9, 1_000_000]);
    // 同费项 code 跨源合并：MIS 全在 01，PMS 是 rent，各自一行。
    const misFee = result.byFee.find((row: any) => row.feeCode === '01');
    assert.equal(misFee.amountCents, MIS_TOTAL);
    assert.equal(misFee.feeName, '管理费');
    const methodWechat = result.byMethod.find((row: any) => row.method === '微信');
    assert.equal(methodWechat.amountCents, 15_246_910 + 15_314_220);
    assert.equal(methodWechat.count, 992 + 844);
    const methodCash = result.byMethod.find((row: any) => row.method === '现金');
    assert.equal(methodCash.amountCents, 16_243_810 + 1_000_000);
    const cashier = result.byCashier.find((row: any) => row.cashier === '刘微微');
    assert.equal(cashier.amountCents, 46_508_500);
    const trendSum = result.trend.reduce((sum: number, row: any) => sum + row.amountCents, 0);
    assert.equal(trendSum, MIS_TOTAL + 1_000_000);
    assert.equal(result.message, null);
  } finally {
    await pg.close();
  }
});

test('收费报表 summary：communityId 过滤只取对应源，02+03 映射同一 PMS community', async () => {
  const { pg, service, user } = await fixture();
  try {
    const community2: any = await service.feeReport({ from: '2026-10-01', to: '2026-10-31', communityId: 2 }, user);
    assert.equal(community2.totals.netCents, 15_314_220 + 16_243_810);
    assert.equal(community2.totals.receiptCount, 844 + 837);
    assert.deepEqual(
      community2.byCommunity.map((row: any) => [row.officeCode, row.communityId, row.source]).sort(),
      [['02', 2, 'mis'], ['03', 2, 'mis']],
    );
    const pmsOnly: any = await service.feeReport({ from: '2026-10-01', to: '2026-10-31', communityId: 9 }, user);
    assert.equal(pmsOnly.totals.netCents, 1_000_000);
    assert.deepEqual(pmsOnly.byCommunity.map((row: any) => row.source), ['pms']);
    assert.equal(pmsOnly.message, null);
    const absent: any = await service.feeReport({ from: '2026-10-01', to: '2026-10-31', communityId: 99 }, user);
    assert.equal(absent.totals.netCents, 0);
    assert.deepEqual(absent.byCommunity, []);
    assert.match(absent.message, /无 PMS 收费数据，且不在旧系统镜像范围/);
  } finally {
    await pg.close();
  }
});

test('收费报表 summary：同 community 有 PMS 数据时 MIS 不重复计入', async () => {
  const { pg, service, user } = await fixture({ pmsCommunityId: 2, pmsAmount: 500_000 });
  try {
    const result: any = await service.feeReport({ from: '2026-10-01', to: '2026-10-31', communityId: 2 }, user);
    assert.equal(result.totals.netCents, 500_000);
    assert.equal(result.totals.receiptCount, 1);
    assert.deepEqual(result.byCommunity.map((row: any) => [row.source, row.communityId]), [['pms', 2]]);
  } finally {
    await pg.close();
  }
});

test('收费报表 detail：两源字段/维度过滤/分页/totals', async () => {
  const { pg, service, user } = await fixture();
  try {
    const all: any = await service.feeReportDetail({ from: '2026-10-01', to: '2026-10-31', limit: 10 }, user);
    assert.equal(all.totals.count, MIS_ROWS + 1);
    assert.equal(all.totals.amountCents, MIS_TOTAL + 1_000_000);
    assert.equal(all.rows.length, 10);
    // PMS 收款 paid_at 带 10:00 时间，旧 MIS 只到日期，按时间倒序 PMS 排在最前。
    assert.equal(all.rows[0].source, 'pms');
    assert.ok(all.rows.slice(1).every((row: any) => row.source === 'mis'));
    const misRow = all.rows.find((row: any) => row.source === 'mis');
    assert.equal(misRow.officeCode, '04');
    assert.equal(misRow.communityId, 16);
    assert.match(misRow.address, /旧系统地址/);
    assert.match(misRow.receiptNo, /^WH-/);
    assert.equal(misRow.method, '转账');

    const pmsOnly: any = await service.feeReportDetail({ from: '2026-10-01', to: '2026-10-31', source: 'pms' }, user);
    assert.equal(pmsOnly.totals.count, 1);
    assert.equal(pmsOnly.rows[0].communityId, 9);
    assert.equal(pmsOnly.rows[0].amountCents, 1_000_000);
    assert.equal(pmsOnly.rows[0].receiptNo, 'PMS001');

    const office02: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31', dimension: 'community', key: '02', source: 'mis' }, user,
    );
    assert.equal(office02.totals.count, 844);
    assert.equal(office02.totals.amountCents, 15_314_220);
    assert.ok(office02.rows.every((row: any) => row.officeCode === '02' && row.communityId === 2));

    const fee01: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31', dimension: 'fee', key: '01', source: 'mis' }, user,
    );
    assert.equal(fee01.totals.count, MIS_ROWS);
    assert.equal(fee01.totals.amountCents, MIS_TOTAL);

    const methodCash: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31', dimension: 'method', key: '现金' }, user,
    );
    assert.equal(methodCash.totals.count, 837 + 1);
    assert.equal(methodCash.totals.amountCents, 16_243_810 + 1_000_000);

    const cashierPms: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31', dimension: 'cashier', key: 'PMS收费员' }, user,
    );
    assert.equal(cashierPms.totals.count, 1);

    const day: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31', dimension: 'day', key: '2026-10-05' }, user,
    );
    assert.equal(day.totals.count, MIS_ROWS + 1);

    const page: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31', limit: 5, offset: 5 }, user,
    );
    assert.equal(page.rows.length, 5);
    assert.deepEqual(page.totals, all.totals);
  } finally {
    await pg.close();
  }
});

test('收费报表 detail：access 范围收敛到可看到的 community', async () => {
  const { pg, service, user } = await fixture();
  try {
    const scoped: any = await service.feeReportDetail(
      { from: '2026-10-01', to: '2026-10-31' },
      user,
      { scopeAll: false, communityIds: [2] } as never,
    );
    assert.equal(scoped.totals.count, 844 + 837);
    assert.equal(scoped.totals.amountCents, 15_314_220 + 16_243_810);
    assert.ok(scoped.rows.every((row: any) => ['02', '03'].includes(row.officeCode)));
  } finally {
    await pg.close();
  }
});

test('收费报表导出：Excel 含旧 MIS 明细 sheet、按小区含 source/officeCode、截断注明', async () => {
  const { pg, service, user } = await fixture();
  try {
    const controller = controllerFor(service);
    const file: any = await controller.feeReportExport(
      { from: '2026-10-01', to: '2026-10-31' }, user, { scopeAll: true } as never,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks) as any);
    const names = workbook.worksheets.map((sheet) => sheet.name);
    assert.ok(names.includes('按小区'));
    assert.ok(names.includes('旧系统实收明细'));
    const communitySheet = workbook.getWorksheet('按小区')!;
    const communityRows: any[] = [];
    communitySheet.eachRow((row) => communityRows.push(row.values));
    const header = communityRows[0]?.map((value: any) => String(value ?? ''));
    assert.ok(header.includes('source'));
    assert.ok(header.includes('officeCode'));
    const detailSheet = workbook.getWorksheet('旧系统实收明细')!;
    const detailRows: any[] = [];
    detailSheet.eachRow((row) => detailRows.push(row.values));
    assert.ok(detailRows.length >= 3);
    const detailValues = JSON.stringify(detailRows.slice(1).map((row: any) => row.map((v: any) => v ?? '')));
    assert.match(detailValues, /旧系统地址/);
    assert.match(detailValues, /WH-/);
  } finally {
    await pg.close();
  }
});

test('收费报表：MIS 镜像表缺失时只显示 PMS 数据，不报错', async () => {
  const { pg, service, user } = await fixture({ withMis: false });
  try {
    const result: any = await service.feeReport({ from: '2026-10-01', to: '2026-10-31' }, user);
    assert.equal(result.totals.netCents, 1_000_000);
    assert.deepEqual(result.byCommunity.map((row: any) => row.source), ['pms']);
    const detail: any = await service.feeReportDetail({ from: '2026-10-01', to: '2026-10-31' }, user);
    assert.equal(detail.totals.count, 1);
    assert.equal(detail.rows[0].source, 'pms');
  } finally {
    await pg.close();
  }
});
