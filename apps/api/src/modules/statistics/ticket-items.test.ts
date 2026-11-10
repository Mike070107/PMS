import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorP4Extras1795500000000 } from '../../migrations/1795500000000-MisMirrorP4Extras';
import { TicketReportService } from './ticket-report.service';
import { TicketItemsSummaryQueryDto, TicketItemsDetailQueryDto } from './dto';
import { StatisticsController } from './statistics.controller';

const user = { id: 7, tenantId: 1 } as never;
const all = { scopeAll: true } as never;
const phaseTwo = { scopeAll: false, communityIds: [2] } as never;
async function database() {
  const pg = new PGlite();
  for (const migration of [new MisMirror1794500000000(), new MisMirrorP4Extras1795500000000()]) {
    await migration.up({ query: (sql: string) => pg.query(sql) } as any);
  }
  const service = new TicketReportService({ query: async (sql: string, params?: any[]) => (await pg.query(sql, params)).rows } as any,
    { find: async () => [{ id: 1, name: '枫桦景苑一期' }, { id: 2, name: '枫桦景苑二期' }] } as any);
  return { pg, service };
}
async function seedSmall(pg: PGlite) {
  await pg.exec(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name) VALUES ('01','管理费'),('04','泊位费');
    INSERT INTO mis_mirror_ticket(id,ticket_no,warehouse_no,office_code,issue_date,payer,address,customer_name,invoice_no,amount_cents,tax_cents)
    VALUES (1,'T-1','W-1','01','2023-01-01','付款甲','228/2/202','住户甲','INV-1',1500,100),
    (2,'T-2','W-2','02','2023-01-02','付款乙','228/3/202','住户乙','INV-2',-200,0),
    (3,'T-3','W-3','03','2023-01-03','付款丙',NULL,NULL,NULL,300,0);
    INSERT INTO mis_mirror_ticket_item(id,ticket_id,item_name,fee_code,amount_cents,tax_cents) VALUES
    (1,1,'物业','01',1000,100),(2,1,'车位','04',500,0),(3,2,'物业退款','01',-200,0),(4,3,'源库未知项目','XX',300,0);`);
}

test('开票统计：分组去重张数、负数和税额，合计不是逐组张数相加', async () => {
  const { pg, service } = await database();
  try {
    await seedSmall(pg);
    const result = await service.ticketItemsSummary({}, user, all);
    assert.equal(result.available, true);
    assert.deepEqual(result.totals, { itemCount: 4, ticketCount: 3, amountCents: 1600, taxCents: 100, incomeCents: 1500 });
    assert.deepEqual(result.rows.map(r => [r.key, r.label, r.ticketCount, r.amountCents]),
      [['01', '管理费', 2, 800], ['04', '泊位费', 1, 500], ['XX', 'XX', 1, 300]]);
    assert.equal(result.rows.reduce((sum, row) => sum + row.ticketCount, 0), 4);
    const offices = await service.ticketItemsSummary({ groupBy: 'office' }, user, all);
    assert.deepEqual(offices.rows.map(r => [r.key, r.amountCents]), [['01', 1500], ['03', 300], ['02', -200]]);
    const days = await service.ticketItemsSummary({ groupBy: 'day' }, user, all);
    assert.deepEqual(days.rows.map(r => r.key), ['2023-01-01', '2023-01-02', '2023-01-03']);
  } finally { await pg.close(); }
});

test('开票统计：597行/588票生产基准合成回归（非生产原始明细）', async () => {
  const { pg, service } = await database();
  try {
    // 合成数据仅复现已核实的聚合基准，不冒充原始票据。
    await pg.exec(`INSERT INTO mis_mirror_ticket(id,ticket_no,office_code,issue_date)
      SELECT n,'T-'||n,CASE WHEN n<=218 THEN '01' WHEN n<=373 THEN '02' ELSE '03' END,'2023-01-01'::date FROM generate_series(1,588) n;
      INSERT INTO mis_mirror_ticket_item(id,ticket_id,fee_code,amount_cents,tax_cents)
      SELECT n,CASE WHEN n<=220 THEN LEAST(n,218) WHEN n<=379 THEN LEAST(n-2,373) ELSE LEAST(n-6,588) END,
      CASE WHEN n<=412 THEN '01' WHEN n<=574 THEN '04' ELSE '14' END,
      CASE WHEN n=220 THEN 34512310-21900 WHEN n=379 THEN 31765380-15800
      WHEN n=412 THEN 30799390-3200 WHEN n=574 THEN 18585000-16100
      WHEN n=597 THEN 1822500-2200 ELSE 100 END,0 FROM generate_series(1,597) n;`);
    const result = await service.ticketItemsSummary({}, user, all);
    assert.deepEqual(result.totals, { itemCount: 597, ticketCount: 588, amountCents: 117484580, taxCents: 0, incomeCents: 117484580 });
    assert.deepEqual(result.rows.map(r => [r.key, r.itemCount, r.amountCents]),
      [['01', 412, 97077080], ['04', 162, 18585000], ['14', 23, 1822500]]);
    const offices = await service.ticketItemsSummary({ groupBy: 'office' }, user, all);
    assert.deepEqual(offices.rows.map(r => [r.key, r.itemCount, r.ticketCount, r.amountCents]),
      [['03', 218, 215, 51206890], ['01', 220, 218, 34512310], ['02', 159, 155, 31765380]]);
  } finally { await pg.close(); }
});

test('开票明细：分页不改变合计、筛选按闭区间且支持单侧日期与费用代码', async () => {
  const { pg, service } = await database();
  try {
    await seedSmall(pg);
    const detail = await service.ticketItemsDetail({ limit: 1, offset: 1 }, user, all);
    assert.equal(detail.rows.length, 1);
    assert.equal(detail.count, 4);
    assert.equal(detail.totals?.amountCents, 1600);
    assert.equal(detail.rows[0].ticketNo, 'T-2');
    const filtered = await service.ticketItemsDetail({ dateFrom: '2023-01-01', dateTo: '2023-01-01', feeCodes: ['04'] }, user, all);
    assert.equal(filtered.count, 1);
    assert.equal(filtered.rows[0].incomeCents, 500);
    assert.equal(filtered.rows[0].feeName, '泊位费');
    assert.equal(detail.coverage?.dateFrom, '2023-01-01');
    assert.equal(detail.coverage?.dateTo, '2023-01-03');
    assert.equal(detail.coverage?.nonzeroTaxItemCount, 1);
    assert.equal(detail.coverage?.unknownTaxItemCount, 0);
    assert.equal(filtered.coverage?.itemCount, 1);
    assert.equal((await service.ticketItemsDetail({ dateFrom: '2023-01-03' }, user, all)).count, 1);
    assert.equal((await service.ticketItemsDetail({ dateTo: '2023-01-01' }, user, all)).count, 2);
    for (const keyword of ['INV-1', 'W-1', '车位']) {
      assert.ok((await service.ticketItemsDetail({ keyword }, user, all)).count! > 0);
    }
    assert.equal((await service.ticketItemsDetail({ ticketNo: "T-1' OR 1=1--" }, user, all)).count, 0);
  } finally { await pg.close(); }
});

test('范围收敛：请求管理处不能越权，逐票详情不可按id跨小区读取', async () => {
  const { pg, service } = await database();
  try {
    await seedSmall(pg);
    const scoped = await service.ticketItemsSummary({}, user, phaseTwo);
    assert.equal(scoped.totals?.amountCents, 100);
    assert.equal(scoped.coverage?.dateFrom, '2023-01-02');
    assert.equal(scoped.coverage?.itemCount, 2);
    const denied = await service.ticketItemsSummary({ officeCodes: ['01'] }, user, phaseTwo);
    assert.equal(denied.rows.length, 0);
    assert.equal(denied.totals?.amountCents, 0);
    assert.equal((await service.ticketItemsDetail({}, user, phaseTwo)).count, 2);
    await assert.rejects(service.ticketItems(1, user, phaseTwo), NotFoundException);
    await assert.rejects(service.ticketItems(999, user, all), NotFoundException);
    await assert.rejects(service.ticketItems(-1, user, all), BadRequestException);
    const single = await service.ticketItems(1, user, all);
    assert.equal(single.ticket.address, '228/2/202');
    assert.equal(single.rows.length, 2);
    assert.equal(single.totals?.amountCents, single.ticket.amountCents);
    assert.equal(single.totals?.incomeCents, 1400);
  } finally { await pg.close(); }
});

test('未同步开票镜像不报假0；已同步空表可报真实0', async () => {
  const { pg, service } = await database();
  try {
    const missing = await service.ticketItemsSummary({}, user, all);
    assert.equal(missing.available, false);
    assert.equal(missing.totals, null);
    assert.equal((await service.ticketItemsDetail({}, user, all)).count, null);
    await seedSmall(pg);
    await pg.exec('DELETE FROM mis_mirror_ticket_item');
    const ticket = await service.ticketItems(1, user, all);
    assert.equal(ticket.available, false);
    assert.equal(ticket.totals, null);
    await pg.exec(`INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at) VALUES (1,'ticket_item',now())`);
    const empty = await service.ticketItemsSummary({}, user, all);
    assert.equal(empty.available, true);
    assert.equal(empty.totals?.amountCents, 0);
  } finally { await pg.close(); }
});

test('输入校验与路由权限：拒绝不合法日期/分组/分页、只读business:view', async () => {
  const { pg, service } = await database();
  try {
    await assert.rejects(service.ticketItemsSummary({ dateFrom: '2023-02-30' }, user, all), BadRequestException);
    await assert.rejects(service.ticketItemsSummary({ dateFrom: '2023-02-01', dateTo: '2023-01-01' }, user, all), BadRequestException);
    await assert.rejects(service.ticketItemsSummary({ groupBy: 'oops' } as any, user, all), BadRequestException);
    await assert.rejects(service.ticketItemsDetail({ limit: 501 }, user, all), BadRequestException);
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    const dto = await pipe.transform({ groupBy: 'office', officeCodes: '01,02', feeCodes: '01' }, { type: 'query', metatype: TicketItemsSummaryQueryDto });
    assert.deepEqual(dto.officeCodes, ['01', '02']);
    assert.deepEqual(dto.feeCodes, ['01']);
    for (const value of [{ limit: '0' }, { offset: '-1' }, { ticketNo: 'x'.repeat(61) }, { unexpected: '1' }]) {
      await assert.rejects(pipe.transform(value, { type: 'query', metatype: TicketItemsDetailQueryDto }), BadRequestException);
    }
    for (const [method, path] of [['ticketItemsSummary', 'ticket-items/summary'], ['ticketItemsDetail', 'ticket-items/detail'], ['ticketItems', 'tickets/:id/items']]) {
      const handler = (StatisticsController.prototype as any)[method];
      assert.equal(Reflect.getMetadata(PATH_METADATA, handler), path);
      assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handler), { items: [{ pageKey: 'business', action: 'view' }] });
    }
  } finally { await pg.close(); }
});

test('住户票据查询复用既有列表：可按房号/住户/付款人/发票号检索', async () => {
  const { pg, service } = await database();
  try {
    await seedSmall(pg);
    for (const keyword of ['228/2/202', '住户甲', '付款甲', 'INV-1', 'T-1']) {
      const result = await service.tickets({ keyword }, user, all);
      assert.equal(result.count, 1, keyword);
      assert.equal(result.rows[0].id, 1);
    }
  } finally { await pg.close(); }
});
