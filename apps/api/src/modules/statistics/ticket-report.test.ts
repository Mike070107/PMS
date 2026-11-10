import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PGlite } from '@electric-sql/pglite';
import { PERMISSION_KEY } from '../../common/require-permission.decorator';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorP4Extras1795500000000 } from '../../migrations/1795500000000-MisMirrorP4Extras';
import { TicketReportService } from './ticket-report.service';
import { TicketSummaryQueryDto, TicketsQueryDto } from './dto';
import { StatisticsController } from './statistics.controller';

const tenantId = 1;
const user = { id: 7, tenantId } as never;
const scopeAll = { scopeAll: true } as never;
const scopeCommunityTwo = { scopeAll: false, communityIds: [2] } as never;

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
];

async function makeDatabase() {
  const pg = new PGlite();
  await new MisMirror1794500000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorBillNature1795300000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorP4Extras1795500000000().up({ query: (sql: string) => pg.query(sql) } as any);
  return pg;
}

function serviceFor(pg: PGlite) {
  const communityRepo = { find: async () => communities } as any;
  return new TicketReportService(
    { query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows } as any,
    communityRepo,
  );
}

let nextZj = 1;
async function addBill(pg: PGlite, input: {
  officeCode: string; feeCode: string; feeName?: string; amountCents: number;
  paidDate: string; method?: string | null; cashier?: string | null; refundDate?: string | null;
}) {
  await pg.query(
    `INSERT INTO mis_mirror_bill(zj_id,office_code,s_id,owner_name,room_no,address,fee_code,fee_name,nature_code,period,
       amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at)
     VALUES($1,$2,1,'测试业主','101','测试路1号101',$3,$4,'01','202610',$5,$6,$7,$8,$9,now())`,
    [nextZj++, input.officeCode, input.feeCode, input.feeName ?? input.feeCode, input.amountCents,
      input.paidDate, input.refundDate ?? null, input.method ?? null, input.cashier ?? null],
  );
}

async function addTicket(pg: PGlite, input: {
  id: number; ticketNo: string; officeCode: string; issueDate: string; feeCode: string;
  amountCents: number; taxCents: number; preIssue?: boolean; voidDate?: string | null;
  writeoffDate?: string | null; payer?: string; invoiceNo?: string | null;
}) {
  await pg.query(
    `INSERT INTO mis_mirror_ticket(id,ticket_no,warehouse_no,office_code,issue_date,payer,amount_cents,tax_cents,
       pre_issue,receipt_date,issuer,payee,void_date,writeoff_date,payment_method,invoice_no,type)
     VALUES($1,$2,'WH-001',$3,$4,$5,$6,$7,$8,$4,'胡美君','胡美君',$9,$10,'现金',$11,NULL)`,
    [input.id, input.ticketNo, input.officeCode, input.issueDate, input.payer ?? '付款人',
      input.amountCents, input.taxCents, input.preIssue ?? false, input.voidDate ?? null,
      input.writeoffDate ?? null, input.invoiceNo ?? null],
  );
  await pg.query(
    `INSERT INTO mis_mirror_ticket_item(id,ticket_id,ticket_no,item_name,project,amount_cents,tax_cents,
       fee_code,warehouse_no,non_daily,tax_rate)
     VALUES($1,$2,$3,'品名','项目',$4,$5,$6,'WH-001',false,0)`,
    [input.id, input.id, input.ticketNo, input.amountCents, input.taxCents, input.feeCode],
  );
}

/** 收款汇总验收夹具（§4.2 生产实测 02/2026-10 + 11 月全处 cashier 块）。 */
async function seed(pg: PGlite) {
  for (const [id, name] of [[1, '现金'], [2, '支付宝'], [3, '微信'], [4, '银联支付'], [5, '转账']] as Array<[number, string]>) {
    await pg.query(`INSERT INTO mis_mirror_payment_method(method_id,method_name) VALUES($1,$2)`, [id, name]);
  }
  for (const [code, name] of [['01', '管理费'], ['04', '泊位费'], ['14', '停车管理费'], ['16', '置业泊位费']] as const) {
    await pg.query(`INSERT INTO mis_mirror_fee_item(fee_code,fee_name) VALUES($1,$2)`, [code, name]);
  }
  const oct = '2026-10-05';
  // 02 管理处 2026-10：费项×收款方式，合计=§4.2 验收 15,314,220。
  const rows: Array<[string, number, string]> = [
    ['01', 1_610_820, '现金'], ['01', 6_152_700, '微信'], ['01', 1_872_900, '支付宝'], ['01', 2_278_800, '转账'],
    ['04', -60_000, '现金'], ['04', 2_790_000, '微信'], ['04', 315_000, '支付宝'],
    ['14', 324_000, '微信'], ['16', 30_000, '微信'],
  ];
  for (const [feeCode, amount, method] of rows) {
    await addBill(pg, { officeCode: '02', feeCode, amountCents: amount, paidDate: oct, method, cashier: '赵丽萍' });
  }
  // 退款信息列（refund_date 在区间；原收款不在本期）。
  await addBill(pg, { officeCode: '02', feeCode: '01', amountCents: 100_000, paidDate: '2026-09-01', refundDate: '2026-10-20', method: '现金', cashier: '赵丽萍' });
  // cashier 块（2026-10 全部管理处）：赵丽萍 46,508,500 / 刘微微 34,797,740 / 伍庆中 12,007,200。
  await addBill(pg, { officeCode: '01', feeCode: '01', amountCents: 31_194_280, paidDate: oct, method: '现金', cashier: '赵丽萍' });
  await addBill(pg, { officeCode: '03', feeCode: '01', amountCents: 34_797_740, paidDate: oct, method: '转账', cashier: '刘微微' });
  await addBill(pg, { officeCode: '04', feeCode: '01', amountCents: 12_007_200, paidDate: oct, method: '微信', cashier: '伍庆中' });
  // 票据（开票）块：02 管理处 2026-10；含 issued/written_off/pre_issue/voided 与 1 张 11 月。
  await addTicket(pg, { id: 1001, ticketNo: 'H-1001', officeCode: '02', issueDate: '2026-10-10', feeCode: '01', amountCents: 50_000, taxCents: 5_000, invoiceNo: 'FP-1' });
  await addTicket(pg, { id: 1002, ticketNo: 'H-1002', officeCode: '02', issueDate: '2026-10-11', feeCode: '04', amountCents: 30_000, taxCents: 3_000, writeoffDate: '2026-10-20' });
  await addTicket(pg, { id: 1003, ticketNo: 'H-1003', officeCode: '02', issueDate: '2026-10-12', feeCode: '01', amountCents: 20_000, taxCents: 2_000, preIssue: true });
  await addTicket(pg, { id: 1004, ticketNo: 'H-1004', officeCode: '02', issueDate: '2026-10-13', feeCode: '01', amountCents: 15_000, taxCents: 1_500, preIssue: true, voidDate: '2026-10-14' });
  await addTicket(pg, { id: 1005, ticketNo: 'H-1005', officeCode: '02', issueDate: '2026-10-14', feeCode: '16', amountCents: 10_000, taxCents: 1_000 });
  await addTicket(pg, { id: 1006, ticketNo: 'H-1006', officeCode: '02', issueDate: '2026-11-01', feeCode: '01', amountCents: 99_999, taxCents: 9_999, payer: '十一月付款人' });
}

test('收款汇总表：费项×收款方式=§4.2 验收，票据块按 fee_code 匹配，收款人块=全处验收', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const result: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'] } as never, user, scopeAll);
    assert.equal(result.available, true);
    assert.deepEqual(result.methodColumns.map((column: any) => column.label), ['现金', '支付宝', '微信', '银联支付', '转账', '未记录']);
    const byFee = new Map<string, any>(result.rows.map((row: any) => [row.feeCode, row] as [string, any]));
    const fee01: any = byFee.get('01');
    assert.equal(fee01.feeName, '管理费');
    assert.deepEqual(fee01.methods, { 现金: 1_610_820, 支付宝: 1_872_900, 微信: 6_152_700, 银联支付: 0, 转账: 2_278_800, 未记录: 0 });
    assert.equal(fee01.receivedCents, 11_915_220);
    assert.equal(fee01.netCents, 11_915_220);
    assert.equal(fee01.refundCents, 100_000);
    assert.equal(fee01.ticketAmountCents, 85_000);
    assert.equal(fee01.ticketTaxCents, 8_500);
    assert.equal(fee01.ticketIncomeCents, 76_500);
    assert.equal(fee01.ticketCount, 3);
    const fee04: any = byFee.get('04');
    assert.deepEqual([fee04.methods.现金, fee04.methods.微信, fee04.methods.支付宝, fee04.receivedCents], [-60_000, 2_790_000, 315_000, 3_045_000]);
    assert.deepEqual([byFee.get('14').receivedCents, byFee.get('16').receivedCents], [324_000, 30_000]);
    assert.deepEqual(result.totals.methods, { 现金: 1_550_820, 支付宝: 2_187_900, 微信: 9_296_700, 银联支付: 0, 转账: 2_278_800, 未记录: 0 });
    assert.equal(result.totals.receivedCents, 15_314_220);
    assert.equal(result.totals.netCents, 15_314_220);
    assert.equal(result.totals.refundCents, 100_000);
    assert.equal(result.totals.ticketAmountCents, 125_000);
    assert.equal(result.totals.ticketTaxCents, 12_500);
    assert.equal(result.totals.ticketIncomeCents, 112_500);
    assert.equal(result.totals.ticketCount, 5);
    assert.equal(result.count, 4);
    // 02 范围收款人块：只有赵丽萍，金额=费项合计。
    assert.deepEqual(result.cashierRows.map((row: any) => [row.cashier, row.netCents]), [['赵丽萍', 15_314_220]]);
    assert.equal(result.cashierTotals.netCents, 15_314_220);

    // 全管理处不选 officeCodes：cashier 块 = 生产验收。
    const all: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31' } as never, user, scopeAll);
    assert.deepEqual(
      all.cashierRows.map((row: any) => [row.cashier, row.netCents]),
      [['赵丽萍', 46_508_500], ['刘微微', 34_797_740], ['伍庆中', 12_007_200]],
    );
    assert.equal(all.cashierTotals.netCents, 93_313_440);
    assert.equal(all.cashierTotals.rows, 12);
    assert.equal(all.cashierRows[0].methods.现金, 1_550_820 + 31_194_280);
  } finally {
    await pg.close();
  }
});

test('收款汇总表：feeCodes/paymentMethods/cashier 过滤、分页 totals、范围收敛', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const feeOnly: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'], feeCodes: ['01'] } as never, user, scopeAll);
    assert.deepEqual(feeOnly.rows.map((row: any) => row.feeCode), ['01']);
    assert.equal(feeOnly.totals.receivedCents, 11_915_220);
    assert.equal(feeOnly.totals.ticketAmountCents, 85_000);
    const methodOnly: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'], paymentMethods: ['微信'] } as never, user, scopeAll);
    assert.equal(methodOnly.totals.methods.微信, 9_296_700);
    assert.equal(methodOnly.totals.methods.现金, 0);
    assert.equal(methodOnly.totals.receivedCents, 9_296_700);
    const cashierOnly: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'], cashier: '赵丽萍' } as never, user, scopeAll);
    assert.equal(cashierOnly.totals.receivedCents, 15_314_220);
    assert.deepEqual(cashierOnly.cashierRows.map((row: any) => row.cashier), ['赵丽萍']);
    // 分页费用行不影响 totals。
    const paged: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'], limit: 2, offset: 0 } as never, user, scopeAll);
    assert.equal(paged.rows.length, 2);
    assert.equal(paged.count, 4);
    assert.deepEqual(paged.totals, (await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'] } as never, user, scopeAll)).totals);
    // 范围收敛：二期账号只看到 02/03 的收款人块。
    const scoped: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31' } as never, user, scopeCommunityTwo);
    assert.deepEqual(scoped.cashierRows.map((row: any) => row.cashier), ['刘微微', '赵丽萍']);
    assert.equal(scoped.cashierTotals.netCents, 15_314_220 + 34_797_740);
  } finally {
    await pg.close();
  }
});

test('票据情况统计：状态派生/四态过滤/statusCounts 不受 status 影响/totals/keyword/分页', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    const service = serviceFor(pg);
    const all: any = await service.tickets({} as never, user, scopeAll);
    assert.equal(all.available, true);
    assert.equal(all.count, 6);
    assert.deepEqual(all.statusCounts, { issued: 3, written_off: 1, pre_issue: 1, voided: 1 });
    assert.deepEqual(all.totals, {
      count: 6,
      amountCents: 50_000 + 30_000 + 20_000 + 15_000 + 10_000 + 99_999,
      taxCents: 5_000 + 3_000 + 2_000 + 1_500 + 1_000 + 9_999,
      voidedCount: 1,
      preIssueCount: 1,
      writtenOffCount: 1,
    });
    assert.deepEqual(all.rows.map((row: any) => row.id), [1006, 1005, 1004, 1003, 1002, 1001]);
    const voided = all.rows.find((row: any) => row.id === 1004);
    assert.equal(voided.status, 'voided');
    assert.equal(voided.voidDate, '2026-10-14');
    assert.equal(voided.preIssue, true);
    const written = all.rows.find((row: any) => row.id === 1002);
    assert.equal(written.status, 'written_off');
    assert.equal(written.writeoffDate, '2026-10-20');
    assert.equal(written.officeName, '枫桦景苑二期A');

    const issued: any = await service.tickets({ status: 'issued' } as never, user, scopeAll);
    assert.deepEqual(issued.rows.map((row: any) => row.id), [1006, 1005, 1001]);
    assert.equal(issued.totals.count, 3);
    assert.equal(issued.totals.voidedCount, 0);
    // statusCounts 仍是全量（不受 status 过滤）。
    assert.deepEqual(issued.statusCounts, { issued: 3, written_off: 1, pre_issue: 1, voided: 1 });
    assert.deepEqual(((await service.tickets({ status: 'pre_issue' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [1003]);
    assert.deepEqual(((await service.tickets({ status: 'written_off' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [1002]);
    // 日期区间（2026-10 不含 11 月）。
    const oct: any = await service.tickets({ dateFrom: '2026-10-01', dateTo: '2026-10-31' } as never, user, scopeAll);
    assert.equal(oct.count, 5);
    assert.equal(oct.statusCounts.issued, 2);
    assert.equal(oct.totals.amountCents, 125_000);
    // keyword / 分页 / 管理处过滤。
    assert.deepEqual(((await service.tickets({ keyword: 'H-1002' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [1002]);
    assert.deepEqual(((await service.tickets({ keyword: '十一月付款人' } as never, user, scopeAll)) as any).rows.map((row: any) => row.id), [1006]);
    const paged: any = await service.tickets({ limit: 2, offset: 0 } as never, user, scopeAll);
    assert.equal(paged.rows.length, 2);
    assert.deepEqual(paged.totals, all.totals);
    assert.equal(paged.count, 6);
    const office01: any = await service.tickets({ officeCodes: ['01'] } as never, user, scopeAll);
    assert.deepEqual(office01.rows, []);
    assert.equal(office01.statusCounts.issued, 0);
    const scoped: any = await service.tickets({} as never, user, scopeCommunityTwo);
    assert.equal(scoped.count, 6);
  } finally {
    await pg.close();
  }
});

const summaryQuery = { dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: ['02'] };
const ticketFields = ['ticketAmountCents', 'ticketTaxCents', 'ticketIncomeCents', 'ticketCount'];

for (const missing of ['both', 'items', 'tickets', 'item-table', 'ticket-table'] as const) {
  test(`收款汇总表：${missing} 未就绪时票据未知，已知收款与收款人不丢失`, async () => {
    const pg = await makeDatabase();
    try {
      await seed(pg);
      if (missing === 'both' || missing === 'items') await pg.query('DELETE FROM mis_mirror_ticket_item');
      if (missing === 'both' || missing === 'tickets') await pg.query('DELETE FROM mis_mirror_ticket');
      if (missing === 'item-table') await pg.query('DROP TABLE mis_mirror_ticket_item');
      if (missing === 'ticket-table') await pg.query('DROP TABLE mis_mirror_ticket');
      const result: any = await serviceFor(pg).ticketSummary(summaryQuery as never, user, scopeAll);
      assert.equal(result.available, true);
      // 先断言原缺陷本身，而不是只断言新增加的元信息。
      for (const field of ticketFields) {
        assert.equal(result.totals[field], null, field);
        for (const row of result.rows) assert.equal(row[field], null, field);
      }
      assert.equal(result.ticketBlockReady, false);
      assert.equal(result.partial, true);
      assert.equal(result.totals.receivedCents, 15_314_220);
      assert.equal(result.cashierTotals.netCents, 15_314_220);
      assert.deepEqual(result.cashierRows.map((row: any) => row.cashier), ['赵丽萍']);
      assert.match(result.message, /未就绪|未同步/);
      assert.doesNotMatch(result.message, /暂显示 0|无票据数据/);
      // 全越权也不能绕过镜像就绪状态而伪造票据零。
      const denied: any = await serviceFor(pg).ticketSummary(summaryQuery as never, user,
        { scopeAll: false, communityIds: [] } as never);
      assert.deepEqual(denied.rows, []);
      assert.equal(denied.totals.receivedCents, 0);
      assert.equal(denied.totals.ticketAmountCents, null);
    } finally { await pg.close(); }
  });
}

test('收款汇总表：成功同步空票据/空开票明细是真实 0，分块水位取较早值', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    await pg.query('DELETE FROM mis_mirror_ticket_item');
    await pg.query('DELETE FROM mis_mirror_ticket');
    await pg.query(`INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at)
      VALUES (1,'ticket','2026-11-01T01:00:00Z'),(1,'ticket_item','2026-11-01T00:00:00Z')`);
    const result: any = await serviceFor(pg).ticketSummary(summaryQuery as never, user, scopeAll);
    assert.equal(result.ticketBlockReady, true);
    assert.equal(result.partial, false);
    assert.equal(result.ticketDataAsOf, '2026-11-01T00:00:00.000Z');
    assert.equal(result.message, null);
    for (const field of ticketFields) {
      assert.equal(result.totals[field], 0);
      for (const row of result.rows) assert.equal(row[field], 0);
    }
    // 只有票据头已同步，明细未同步，仍为未知（COUNT=0 不是未同步的依据）。
    await pg.query(`DELETE FROM mis_sync_state WHERE source_table='ticket_item'`);
    const partial: any = await serviceFor(pg).ticketSummary(summaryQuery as never, user, scopeAll);
    assert.equal(partial.ticketBlockReady, false);
    assert.equal(partial.totals.ticketAmountCents, null);
  } finally { await pg.close(); }
});

test('收款汇总表：就绪无匹配/全越权是真实 0，跨费项票据合计去重不变', async () => {
  const pg = await makeDatabase();
  try {
    await seed(pg);
    await pg.query(`INSERT INTO mis_mirror_ticket_item(id,ticket_id,fee_code,amount_cents,tax_cents)
      VALUES(2001,1001,'14',1000,100)`);
    const service = serviceFor(pg);
    const result: any = await service.ticketSummary(summaryQuery as never, user, scopeAll);
    assert.equal(result.ticketBlockReady, true);
    assert.equal(result.totals.ticketCount, 5);
    assert.equal(result.totals.ticketAmountCents, 126_000);
    assert.equal(result.rows.find((row: any) => row.feeCode === '14').ticketCount, 1);
    for (const [query, access] of [
      [{ ...summaryQuery, dateFrom: '2025-10-01', dateTo: '2025-10-31' }, scopeAll],
      [summaryQuery, { scopeAll: false, communityIds: [] }],
    ] as const) {
      const empty: any = await service.ticketSummary(query as never, user, access as never);
      assert.equal(empty.ticketBlockReady, true);
      assert.deepEqual(empty.rows, []);
      for (const field of ticketFields) assert.equal(empty.totals[field], 0);
    }
  } finally { await pg.close(); }
});

test('P2-E：未镜像、DTO/日期校验、权限与路由', async () => {
  const pg = await makeDatabase();
  try {
    const service = serviceFor(pg);
    const summary: any = await service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31' } as never, user, scopeAll);
    assert.equal(summary.available, false);
    assert.equal(summary.totals, null);
    assert.match(summary.message, /镜像/);
    const tickets: any = await service.tickets({} as never, user, scopeAll);
    assert.equal(tickets.available, false);
    assert.equal(tickets.totals, null);
    await assert.rejects(
      service.ticketSummary({ dateFrom: '2026-10-01', dateTo: '2026-10-31' } as never, { id: 7 } as never, scopeAll),
      /tenant scope is required/,
    );
    await assert.rejects(
      service.ticketSummary({ dateFrom: '2026-11-01', dateTo: '2026-10-01' } as never, user, scopeAll),
      (error: unknown) => error instanceof BadRequestException,
    );

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transform = (value: Record<string, unknown>, metatype: any) =>
      pipe.transform(value, { type: 'query', metatype });
    await assert.rejects(transform({ dateFrom: '2026-10-01' }, TicketSummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ dateFrom: '2026-13-01', dateTo: '2026-10-31' }, TicketSummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ dateFrom: '2026-10-01', dateTo: '2026-10-31', limit: '501' }, TicketSummaryQueryDto), BadRequestException);
    await assert.rejects(transform({ status: 'bogus' }, TicketsQueryDto), BadRequestException);
    await assert.rejects(transform({ keyword: 'x'.repeat(51) }, TicketsQueryDto), BadRequestException);
    const parsed = (await transform({
      dateFrom: '2026-10-01', dateTo: '2026-10-31', officeCodes: '02,03',
      feeCodes: '01,04', paymentMethods: '现金,微信', cashier: ' 赵丽萍 ',
    }, TicketSummaryQueryDto)) as TicketSummaryQueryDto;
    assert.deepEqual(parsed.officeCodes, ['02', '03']);
    assert.deepEqual(parsed.paymentMethods, ['现金', '微信']);
    assert.equal(parsed.cashier, '赵丽萍');

    const handlers = StatisticsController.prototype as unknown as Record<string, any>;
    for (const key of ['ticketSummary', 'tickets']) {
      assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, handlers[key]), {
        items: [{ pageKey: 'business', action: 'view' }],
      });
      assert.equal(Reflect.getMetadata(METHOD_METADATA, handlers[key]), RequestMethod.GET, key);
    }
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.ticketSummary), 'ticket-summary');
    assert.equal(Reflect.getMetadata(PATH_METADATA, handlers.tickets), 'tickets');
  } finally {
    await pg.close();
  }
});
