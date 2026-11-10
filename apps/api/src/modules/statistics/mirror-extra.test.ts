import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { MisMirror1794500000000 } from '../../migrations/1794500000000-MisMirror';
import { MisMirrorP4Extras1795500000000 } from '../../migrations/1795500000000-MisMirrorP4Extras';
import { MisMirrorBillNature1795300000000 } from '../../migrations/1795300000000-MisMirrorBillNature';
import { MisMirrorOwnerReportFields1795600000000 } from '../../migrations/1795600000000-MisMirrorOwnerReportFields';
import { MisMirrorService } from '../fees/mis-mirror.service';

const tenantId = 1;

async function makeDatabase() {
  const pg = new PGlite();
  await new MisMirror1794500000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorBillNature1795300000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorP4Extras1795500000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await new MisMirrorOwnerReportFields1795600000000().up({ query: (sql: string) => pg.query(sql) } as any);
  await pg.query('ALTER TABLE mis_sync_state ADD COLUMN IF NOT EXISTS consecutive_failures int');
  await pg.query('ALTER TABLE mis_sync_state ADD COLUMN IF NOT EXISTS last_failure_at timestamptz');
  return pg;
}

interface FakeRead {
  (sql: string, params: Record<string, unknown>): Promise<{ recordsets: any[][] }>;
}

function makeService(pg: PGlite, reader: FakeRead) {
  const captured: string[] = [];
  const misFees = {
    mirrorRead: async (sql: string, params: Record<string, unknown> = {}) => {
      captured.push(sql);
      return reader(sql, params);
    },
  } as any;
  const configRepo = { findOne: async () => ({ value: { mode: 'mirror' } }) } as any;
  const dataSource = {
    query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows,
    transaction: async (fn: any) => fn({ query: async (sql: string, params?: unknown[]) => (await pg.query(sql, params as any[])).rows }),
  } as any;
  return { service: new MisMirrorService(dataSource, misFees, configRepo), captured };
}

const EMPTY = { recordsets: [[]] };

function extraReader(overrides: Partial<Record<string, any>> = {}): FakeRead {
  return async (sql: string) => {
    if (sql.includes('FROM [票据]')) return { recordsets: [overrides.ticket ?? []] };
    if (sql.includes('FROM [票据开票数据]')) return { recordsets: [overrides.item ?? []] };
    if (sql.includes('FROM [票据核销记录]')) return { recordsets: [overrides.writeoff ?? []] };
    if (sql.includes('FROM [签报情况表]')) return { recordsets: [overrides.signoff ?? []] };
    if (sql.includes('FROM [签报减免信息]')) return { recordsets: [overrides.relief ?? []] };
    return EMPTY;
  };
}

const TICKET = {
  id: 589, ticketNo: 'H20231223105701665', warehouseNo: 'POS机小票', officeCode: '01',
  issueDate: '2023-12-23', payer: '袁明森', amountCents: 45000, taxCents: 0, preIssue: false,
  receiptDate: '2023-12-23', issuer: '胡美君', payee: '胡美君', voidDate: null, voidReason: null,
  writeoffDate: null, paymentMethod: '支付宝', refundDate: null, zhId: 133,
  customerName: null, address: null, invoiceNo: 'FP-001', invoiceCode: '033001', type: null, sourceUpdatedAt: null,
};
const TICKET_ITEM = {
  id: 598, ticketId: 589, ticketNo: 'H20231223105701665', itemName: null, project: '泊位费',
  amountCents: 45000, taxCents: 0, feeCode: '04', warehouseNo: 'POS机小票', receiptVoucherNo: null,
  nonDaily: false, taxRate: 0,
};
const WRITEOFF = {
  id: 1, writeoffNo: 'HX-1', officeCode: '01', writeoffDate: '2023-12-24', quantity: 10, issuedQty: 8,
  voidQty: 1, preIssueQty: 0, unusedQty: 2, issuedAmountCents: 80000, preIssueAmountCents: 0, writeoffUser: '胡美君',
};
const SIGNOFF = {
  id: 23, docNo: '2026-00000022', title: '通海路328弄16号103（348号乙）  [姚冰峰]', type: '减免签报',
  detail: '一次性减免', officeCode: '04', reason: '2026年11-12月租金5000元，经公司批准减免。', zhId: null,
  draftDate: '2026-08-21', approveDate: '2026-08-31', result: null, voided: false, ended: true,
  adjustAmountCents: 123450, feeCode: null, nature: null, sourceUpdatedAt: '2026-08-31T00:00:00',
};
const RELIEF = {
  id: 19, docNo: '2026-00000022', zhId: 2078, feeCode: '02', feeName: '租金',
  oldReceivableCents: 500000, receivableCents: 0, reliefCents: 500000,
  reliefStartDate: '2026-11-21', reliefEndDate: '2026-12-21', reliefDate: '2026-08-21', method: null,
};

test('P4-A 迁移：新增 5 张镜像表 + bill 四列，幂等可重复执行', async () => {
  const pg = await makeDatabase();
  try {
    const tables: any[] = (await pg.query(
      `SELECT tablename FROM pg_tables WHERE tablename LIKE 'mis_mirror_%' ORDER BY tablename`,
    )).rows as any[];
    const names = tables.map((row) => String(row.tablename));
    for (const table of ['mis_mirror_ticket', 'mis_mirror_ticket_item', 'mis_mirror_ticket_writeoff', 'mis_mirror_signoff', 'mis_mirror_relief']) {
      assert.ok(names.includes(table), table);
    }
    const billColumns: any[] = (await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='mis_mirror_bill'
         AND column_name IN ('income_cents','receipt_warehouse_no','invoice_no','receipt_voucher_no')`,
    )).rows as any[];
    assert.equal(billColumns.length, 4);
    // 幂等：重复执行不报错。
    await new MisMirrorP4Extras1795500000000().up({ query: (sql: string) => pg.query(sql) } as any);
    const again: any[] = (await pg.query(`SELECT COUNT(*)::int AS c FROM pg_tables WHERE tablename='mis_mirror_ticket'`)).rows as any[];
    assert.equal(Number(again[0].c), 1);
  } finally {
    await pg.close();
  }
});

test('syncExtraMirrors：5 张表按源字段映射 upsert，金额转分、日期/布尔正确，并写同步水位', async () => {
  const pg = await makeDatabase();
  try {
    const { service, captured } = makeService(pg, extraReader({
      ticket: [TICKET], item: [TICKET_ITEM], writeoff: [WRITEOFF], signoff: [SIGNOFF], relief: [RELIEF],
    }));
    const result = await service.syncExtraMirrors(tenantId);
    assert.deepEqual(result, { synced: 5, failed: [] });

    // 源 SQL 必须取自 MIS 正确表且包含关键列。
    const allSql = captured.join('\n');
    for (const keyword of ['FROM [票据]', 'FROM [票据开票数据]', 'FROM [票据核销记录]', 'FROM [签报情况表]', 'FROM [签报减免信息]',
      '入库单编号', '收款凭证编号', 'OLD应收金额', '减免金额', '数据修改日期', '非日常', '税率', '发票流水号']) {
      assert.ok(allSql.includes(keyword), keyword);
    }

    const ticket: any = (await pg.query(`SELECT * FROM mis_mirror_ticket WHERE id=589`)).rows[0];
    assert.equal(ticket.ticket_no, 'H20231223105701665');
    assert.equal(ticket.warehouse_no, 'POS机小票');
    assert.equal(ticket.office_code, '01');
    assert.equal(ticket.issue_date.toISOString().slice(0, 10), '2023-12-23');
    assert.equal(Number(ticket.amount_cents), 45000);
    assert.equal(Number(ticket.tax_cents), 0);
    assert.equal(ticket.pre_issue, false);
    assert.equal(ticket.invoice_no, 'FP-001');
    assert.equal(ticket.invoice_code, '033001');
    assert.equal(Number(ticket.zh_id), 133);

    const item: any = (await pg.query(`SELECT * FROM mis_mirror_ticket_item WHERE id=598`)).rows[0];
    assert.equal(Number(item.ticket_id), 589);
    assert.equal(item.project, '泊位费');
    assert.equal(Number(item.amount_cents), 45000);
    assert.equal(item.fee_code, '04');
    assert.equal(item.non_daily, false);
    assert.equal(Number(item.tax_rate), 0);

    const writeoff: any = (await pg.query(`SELECT * FROM mis_mirror_ticket_writeoff WHERE id=1`)).rows[0];
    assert.equal(writeoff.writeoff_no, 'HX-1');
    assert.equal(Number(writeoff.quantity), 10);
    assert.equal(Number(writeoff.issued_amount_cents), 80000);

    const signoff: any = (await pg.query(`SELECT * FROM mis_mirror_signoff WHERE id=23`)).rows[0];
    assert.equal(signoff.doc_no, '2026-00000022');
    assert.equal(signoff.type, '减免签报');
    assert.equal(signoff.detail, '一次性减免');
    assert.equal(signoff.office_code, '04');
    assert.equal(signoff.voided, false);
    assert.equal(signoff.ended, true);
    assert.equal(Number(signoff.adjust_amount_cents), 123450);
    assert.equal(signoff.draft_date.toISOString().slice(0, 10), '2026-08-21');
    assert.equal(signoff.approve_date.toISOString().slice(0, 10), '2026-08-31');

    const relief: any = (await pg.query(`SELECT * FROM mis_mirror_relief WHERE id=19`)).rows[0];
    assert.equal(relief.doc_no, '2026-00000022');
    assert.equal(Number(relief.zh_id), 2078);
    assert.equal(relief.fee_name, '租金');
    assert.equal(Number(relief.old_receivable_cents), 500000);
    assert.equal(Number(relief.relief_cents), 500000);
    assert.equal(relief.relief_date.toISOString().slice(0, 10), '2026-08-21');

    const states: any[] = (await pg.query(
      `SELECT source_table,last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table IN ('ticket','ticket_item','ticket_writeoff','signoff','relief') ORDER BY source_table`,
      [tenantId],
    )).rows as any[];
    assert.deepEqual(states.map((row) => row.source_table), ['relief', 'signoff', 'ticket', 'ticket_item', 'ticket_writeoff']);
    assert.ok(states.every((row) => row.last_success_at != null));
  } finally {
    await pg.close();
  }
});

test('syncExtraMirrors：单表失败只记录 last_error，不影响其余表', async () => {
  const pg = await makeDatabase();
  try {
    const reader = async (sql: string) => {
      if (sql.includes('FROM [票据]')) throw new Error('MIS timeout');
      if (sql.includes('FROM [签报减免信息]')) return { recordsets: [[RELIEF]] };
      if (sql.includes('FROM [签报情况表]')) return { recordsets: [[SIGNOFF]] };
      return EMPTY;
    };
    const { service } = makeService(pg, reader);
    const result = await service.syncExtraMirrors(tenantId);
    assert.deepEqual(result.failed, ['ticket']);
    assert.equal(result.synced, 2);
    const failedState: any[] = (await pg.query(
      `SELECT last_error,last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table='ticket'`,
      [tenantId],
    )).rows as any[];
    assert.match(String(failedState[0].last_error), /MIS timeout/);
    assert.equal(failedState[0].last_success_at, null);
    assert.equal(Number(((await pg.query(`SELECT COUNT(*)::int AS c FROM mis_mirror_relief`)).rows as any[])[0].c), 1);
    assert.equal(Number(((await pg.query(`SELECT COUNT(*)::int AS c FROM mis_mirror_signoff`)).rows as any[])[0].c), 1);
  } finally {
    await pg.close();
  }
});

function billSyncReader(overrides: { bill?: any; sweep?: any; extra?: Partial<Record<string, any>> } = {}): FakeRead {
  return async (sql: string) => {
    if (sql.includes('FROM dbo.WYZJ') && sql.includes('TOP (@take)') && sql.includes('w.ZJ_ID > @lastId')) {
      return { recordsets: [overrides.bill ?? []] };
    }
    if (sql.includes('FROM dbo.WYZJ') && sql.includes('w.updatedate > CONVERT(datetime,@since,126)')) {
      return { recordsets: [overrides.sweep ?? []] };
    }
    if (sql.includes('FROM [票据]')) return { recordsets: [overrides.extra?.ticket ?? []] };
    if (sql.includes('FROM [票据开票数据]')) return { recordsets: [overrides.extra?.item ?? []] };
    if (sql.includes('FROM [票据核销记录]')) return { recordsets: [overrides.extra?.writeoff ?? []] };
    if (sql.includes('FROM [签报情况表]')) return { recordsets: [overrides.extra?.signoff ?? []] };
    if (sql.includes('FROM [签报减免信息]')) return { recordsets: [overrides.extra?.relief ?? []] };
    return EMPTY;
  };
}

const BILL_ROW = {
  zjId: 1, officeCode: '02', lId: 1, sId: 1, zhId: 133, ownerName: '袁明森', roomNo: '101',
  address: '永德路228弄1号101', feeCode: '01', feeName: '管理费', natureCode: '01', period: '202610',
  amountCents: 123400, paidDate: '2026-10-01', refundDate: null, paymentMethod: '现金', cashier: '胡美君',
  incomeCents: 116415, receiptWarehouseNo: 'WH-001', invoiceNo: 'INV-001', receiptVoucherNo: 'PZ-001',
  sourceUpdatedAt: '2026-11-01T00:00:00',
};

test('billSelect/upsertBills：增量 SQL 含收入/入库单/发票/凭证列，镜像落库正确', async () => {
  const pg = await makeDatabase();
  try {
    await pg.query(
      `INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at,last_success_at) VALUES($1,'bill',now(),now())`,
      [tenantId],
    );
    const { service, captured } = makeService(pg, billSyncReader({ bill: [BILL_ROW] }));
    await service.syncTick(tenantId);
    const billSql = captured.find((sql) => sql.includes('FROM dbo.WYZJ') && sql.includes('w.ZJ_ID > @lastId')) ?? '';
    for (const keyword of ['w.收入', 'w.票据入库单编号', 'w.发票号码', 'w.凭证号码', 'AS incomeCents', 'AS receiptWarehouseNo', 'AS invoiceNo', 'AS receiptVoucherNo']) {
      assert.ok(billSql.includes(keyword), keyword);
    }
    const bill: any = (await pg.query(`SELECT * FROM mis_mirror_bill WHERE zj_id=1`)).rows[0];
    assert.equal(bill.address, '永德路228弄1号101');
    assert.equal(Number(bill.amount_cents), 123400);
    assert.equal(Number(bill.income_cents), 116415);
    assert.equal(bill.receipt_warehouse_no, 'WH-001');
    assert.equal(bill.invoice_no, 'INV-001');
    assert.equal(bill.receipt_voucher_no, 'PZ-001');
    const state: any[] = (await pg.query(`SELECT synced_rows FROM mis_sync_state WHERE tenant_id=$1 AND source_table='bill'`, [tenantId])).rows as any[];
    assert.equal(Number(state[0].synced_rows), 1);
  } finally {
    await pg.close();
  }
});

test('reloadAll：全量账单 SQL 同样带票据四列，并顺带同步补充镜像', async () => {
  const pg = await makeDatabase();
  try {
    const { service, captured } = makeService(pg, billSyncReader({ extra: { ticket: [TICKET], relief: [RELIEF] } }));
    const result: any = await service.reloadAll(tenantId);
    assert.equal(result.rows, 0);
    const reloadSql = captured.find((sql) => sql.includes('SELECT TOP (@take) w.ZJ_ID AS zjId')) ?? '';
    for (const keyword of ['w.收入', 'w.票据入库单编号', 'w.发票号码', 'w.凭证号码', 'incomeCents']) {
      assert.ok(reloadSql.includes(keyword), keyword);
    }
    assert.equal(Number(((await pg.query(`SELECT COUNT(*)::int AS c FROM mis_mirror_ticket`)).rows as any[])[0].c), 1);
    assert.equal(Number(((await pg.query(`SELECT COUNT(*)::int AS c FROM mis_mirror_relief`)).rows as any[])[0].c), 1);
  } finally {
    await pg.close();
  }
});
