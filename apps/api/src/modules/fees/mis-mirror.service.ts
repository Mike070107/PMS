import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { TenantConfig } from '../../entities';
import { MisFeesService } from './mis-fees.service';
import { misFeeCategoryLabel, misFeeCategorySql } from './mis-fee-category';
import { loadCollectionTargets } from './collection-targets.util';
import { buildScreenSummary } from './screen-summary.util';
import { chargeStandardMirrorParams } from './charge-standard-mirror.util';
import { dimensionMirrorRows } from './dimension-mirror.util';
import { billCursorId, billMirrorRows } from './bill-mirror.util';

type MirrorMode = 'mis' | 'mirror';
type MirrorCommunity = { id: number; name: string; offices: string[] };

const DATA_SOURCE_KEY = 'data_source_mode';
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_TICK = 4;
const MIS_TIMEOUT = 15_000;
const SWEEP_BATCH_FALLBACK = 200;

/**
 * MIS 镜像第一阶段。
 *
 * 同步只读 MIS 的增量小批量（WYZJ updatedate + ZJ_ID 双水位），
 * 全量重灌只允许管理员手工触发；正常读路径在 mirror 模式下完全不访问 MIS。
 */
@Injectable()
export class MisMirrorService {
  private readonly logger = new Logger(MisMirrorService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly misFees: MisFeesService,
    @InjectRepository(TenantConfig) private readonly configRepo: Repository<TenantConfig>,
  ) {}

  async mode(tenantId: number): Promise<MirrorMode> {
    const row = await this.configRepo.findOne({ where: { tenantId, key: DATA_SOURCE_KEY } }).catch(() => null);
    const value = row?.value as { mode?: string } | undefined;
    return value?.mode === 'mirror' ? 'mirror' : 'mis';
  }

  async setMode(tenantId: number, mode: MirrorMode) {
    if (mode !== 'mis' && mode !== 'mirror') throw new BadRequestException('数据源仅支持 mis 或 mirror');
    const row = await this.configRepo.findOne({ where: { tenantId, key: DATA_SOURCE_KEY } });
    const value = { mode };
    if (row) await this.configRepo.save({ ...row, value });
    else await this.configRepo.save(this.configRepo.create({ tenantId, key: DATA_SOURCE_KEY, value }));
    return { mode };
  }

  async status(tenantId: number) {
    const mode = await this.mode(tenantId);
    const state: any[] = await this.dataSource.query(
      `SELECT source_table,last_updated_at,last_id,last_success_at,last_attempt_at,last_error,lag_rows,synced_rows,initialized_at
         FROM mis_sync_state WHERE tenant_id=$1 ORDER BY source_table`,
      [tenantId],
    );
    const counts: any[] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*)::int FROM mis_mirror_bill) AS bills,
         (SELECT COUNT(*)::int FROM mis_mirror_owner) AS owners,
         (SELECT COUNT(*)::int FROM mis_mirror_fee_item) AS fee_items,
         (SELECT COUNT(*)::int FROM mis_mirror_ticket) AS tickets,
         (SELECT COUNT(*)::int FROM mis_mirror_ticket_item) AS ticket_items,
         (SELECT COUNT(*)::int FROM mis_mirror_signoff) AS signoffs,
         (SELECT COUNT(*)::int FROM mis_mirror_relief) AS reliefs,
         (SELECT MAX(synced_at) FROM mis_mirror_bill) AS last_bill_sync`,
    ).catch(() => [{ bills: 0, owners: 0, fee_items: 0, last_bill_sync: null }]);
    return { mode, state, ...(counts[0] ?? {}), dataAsOf: await this.dataAsOf(tenantId) };
  }

  async dataAsOf(tenantId: number): Promise<string | null> {
    const rows: any[] = await this.dataSource.query(
      `SELECT last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table='bill' LIMIT 1`,
      [tenantId],
    ).catch(() => []);
    const value = rows[0]?.last_success_at;
    return value ? new Date(value).toISOString() : null;
  }

  private async assertReady(tenantId: number) {
    const state = await this.dataAsOf(tenantId);
    if (!state) throw new ServiceUnavailableException('MIS 镜像尚未完成初始化或同步，请管理员先执行手工重灌');
    return state;
  }

  /**
   * 5 分钟增量同步入口。用 PG advisory lock 串行；失败只记录，不阻塞后续。
   * 没有 initialized_at 时不做全表扫描，必须由管理员先执行手工 reload。
   */
  async syncTick(tenantId: number) {
    const lock = await this.dataSource.query(`SELECT pg_try_advisory_lock(hashtext('mis-mirror-sync')) AS ok`).catch(() => [{ ok: false }]);
    if (!lock?.[0]?.ok) return { skipped: 'locked', rows: 0 };
    let rows = 0;
    try {
      rows = await this.syncBills(tenantId);
      await this.syncSmallDimensions();
      await this.syncExtraMirrors(tenantId);
      return { skipped: null, rows };
    } catch (error) {
      const consecutiveFailures = await this.recordSyncError(tenantId, 'bill', error).catch(() => 0);
      const staleRows: any[] = await this.dataSource.query(
        `SELECT last_success_at FROM mis_sync_state WHERE tenant_id=$1 AND source_table='bill' LIMIT 1`,
        [tenantId],
      ).catch(() => []);
      const lastSuccessAt = staleRows[0]?.last_success_at ? new Date(staleRows[0].last_success_at).toISOString() : null;
      await this.dataSource.query(
        `INSERT INTO system_logs(tenant_id,category,level,source,action,success,message,detail,created_at,updated_at)
         VALUES($1,'alert','warning','mis-mirror','mis_mirror_sync',false,$2,$3::jsonb,now(),now())`,
        [tenantId, `MIS 镜像同步失败：${(error as Error).message}`.slice(0, 500), JSON.stringify({ error: String((error as Error).message).slice(0, 500), consecutiveFailures, lastSuccessAt })],
      ).catch(() => undefined);
      this.logger.warn(`MIS 镜像增量同步失败：${(error as Error).message}`);
      return { skipped: 'error', rows, failed: true, consecutiveFailures, lastError: String((error as Error).message), lastSuccessAt };
    } finally {
      await this.dataSource.query(`SELECT pg_advisory_unlock(hashtext('mis-mirror-sync'))`).catch(() => undefined);
    }
  }

  private async syncBills(tenantId: number): Promise<number> {
    const states: any[] = await this.dataSource.query(
      `SELECT * FROM mis_sync_state WHERE tenant_id=$1 AND source_table='bill' LIMIT 1`,
      [tenantId],
    );
    const state = states[0];
    if (!state?.initialized_at) {
      if (!state) {
        await this.dataSource.query(
          `INSERT INTO mis_sync_state(tenant_id,source_table,last_error,last_attempt_at)
           VALUES($1,'bill','镜像尚未全量初始化，请管理员先执行手工重灌',now())
           ON CONFLICT (tenant_id,source_table) DO UPDATE SET last_error=EXCLUDED.last_error,last_attempt_at=now()`,
          [tenantId],
        );
      }
      return 0;
    }
    let lastUpdated = state.last_updated_at ? new Date(state.last_updated_at) : null;
    let lastId = billCursorId(state.last_id ?? '0');
    let total = 0;
    // 主增量：ZJ_ID 主键 keyset；不碰 updatedate，保证不扫 65 万行。
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const rows = await this.readNewBillBatch(lastId);
      if (!rows.length) break;
      await this.upsertBills(rows);
      total += rows.length;
      lastId = rows[rows.length - 1].zjId;
      if (rows.length < BATCH_SIZE) break;
    }
    // 补漏：旧 ZJ_ID 的 updatedate 变更每 15 分钟扫一次；不能作为每 5 分钟主谓词。
    const sweepStates: any[] = await this.dataSource.query(
      `SELECT * FROM mis_sync_state WHERE tenant_id=$1 AND source_table='bill_sweep' LIMIT 1`,
      [tenantId],
    );
    const sweep = sweepStates[0];
    const sweepSince = sweep?.last_updated_at
      ? new Date(sweep.last_updated_at)
      : (lastUpdated ?? new Date(Date.now() - 15 * 60_000));
    const due = !sweep?.last_updated_at || Date.now() - new Date(sweep.last_updated_at).getTime() >= 15 * 60_000;
    if (due) {
      let rows: any[] = [];
      try {
        rows = await this.readUpdatedBillBatch(sweepSince);
      } catch (error) {
        // 超时/慢查询降级到 200 行再试一次；仍失败才上抛。
        rows = await this.readUpdatedBillBatch(sweepSince, SWEEP_BATCH_FALLBACK);
      }
      if (rows.length) {
        await this.upsertBills(rows);
        total += rows.length;
        lastUpdated = rows[rows.length - 1].sourceUpdatedAt ? new Date(rows[rows.length - 1].sourceUpdatedAt) : lastUpdated;
      }
      const sweepLast = rows.length ? rows[rows.length - 1].sourceUpdatedAt : sweepSince;
      await this.dataSource.query(
        `INSERT INTO mis_sync_state(tenant_id,source_table,last_updated_at,last_success_at,last_attempt_at,last_error)
         VALUES($1,'bill_sweep',$2,now(),now(),NULL)
         ON CONFLICT (tenant_id,source_table) DO UPDATE SET
           last_updated_at=EXCLUDED.last_updated_at,last_success_at=now(),last_attempt_at=now(),last_error=NULL`,
        [tenantId, sweepLast],
      );
    }
    await this.dataSource.query(
      `UPDATE mis_sync_state
          SET last_updated_at=$2,last_id=$3,last_success_at=now(),last_attempt_at=now(),
              last_error=NULL,lag_rows=$4,synced_rows=COALESCE(synced_rows,0)+$5,
              consecutive_failures=0,last_failure_at=NULL
        WHERE tenant_id=$1 AND source_table='bill'`,
      [tenantId, lastUpdated, lastId, total >= BATCH_SIZE ? BATCH_SIZE : 0, total],
    );
    return total;
  }

  private billSelect(where: string, order: string, params: Record<string, string | number>) {
    return `SELECT TOP (@take) CONVERT(varchar(20),w.ZJ_ID) AS zjId, l.管理处 AS officeCode, CONVERT(varchar(20),l.L_ID) AS lId,
        CONVERT(varchar(20),s.S_ID) AS sId, CONVERT(varchar(20),z.ZH_ID) AS zhId, z.姓名 AS ownerName, s.室 AS roomNo,
        ISNULL(l.地址1,N'')+ISNULL(l.字1,N'')+ISNULL(l.地址2,N'')+ISNULL(l.字2,N'')+
        ISNULL(l.地址3,N'')+ISNULL(l.字3,N'')+ISNULL(l.地址4,N'')+ISNULL(l.字4,N'')+
        ISNULL(s.室,N'')+ISNULL(s.字,N'') AS address,
        w.ZJ_LX AS feeCode, f.XM AS feeName, w.FWXZ_DH AS natureCode, w.ZJ_CNY AS period,
        CAST(ROUND(w.ZJ_JE * 100, 0) AS bigint) AS amountCents,
        CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidDate,
        CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundDate,
        CONVERT(varchar(10),w.ZJ_Jzrq,23) AS bookDate,
        CONVERT(varchar(10),w.ZJ_TZRQ,23) AS adjustDate,
        CONVERT(varchar(10),w.ZJ_Bdrq,23) AS changeDate,
        w.交易订单号 AS tradeOrderNo,
        w.商户订单号 AS merchantOrderNo,
        COALESCE(NULLIF(w.收款方式,N''),m.收款方式) AS paymentMethod,
        w.收款人 AS cashier,
        CAST(ROUND(ISNULL(w.收入,0)*100,0) AS bigint) AS incomeCents,
        w.票据入库单编号 AS receiptWarehouseNo,
        w.发票号码 AS invoiceNo,
        w.凭证号码 AS receiptVoucherNo,
        CONVERT(varchar(19),w.updatedate,126) AS sourceUpdatedAt
      FROM dbo.WYZJ w
      INNER JOIN dbo.业主表 z ON z.ZH_ID=w.ZH_ID
      INNER JOIN dbo.室表 s ON s.S_ID=z.S_ID
      INNER JOIN dbo.楼表 l ON l.L_ID=s.L_ID
      LEFT JOIN dbo.SETUPSFXM f ON f.DH=w.ZJ_LX
      LEFT JOIN dbo.收款方式列表 m ON m.id=w.收款方式ID
      WHERE ${where} AND ISNULL(w.SC,N'0')=N'0'
      ORDER BY ${order}`;
  }

  private async readNewBillBatch(lastId: string) {
    const params: Record<string, string | number> = { take: BATCH_SIZE, lastId: billCursorId(lastId) };
    const sql = this.billSelect('w.ZJ_ID > @lastId', 'w.ZJ_ID ASC', params);
    const result = await this.misFees.mirrorRead(sql, params, MIS_TIMEOUT);
    return billMirrorRows(result, params.lastId as string);
  }

  private async readUpdatedBillBatch(since: Date, take = BATCH_SIZE) {
    const params: Record<string, string | number> = { take, since: this.misDateTime(since) };
    const sql = this.billSelect('w.updatedate > CONVERT(datetime,@since,126)', 'w.updatedate ASC,w.ZJ_ID ASC', params);
    const result = await this.misFees.mirrorRead(sql, params, MIS_TIMEOUT);
    return billMirrorRows(result);
  }

  private async upsertBills(rows: any[]) {
    rows = billMirrorRows({ recordsets: [rows] });
    if (!rows.length) return;
    const fields = ['zjId', 'officeCode', 'lId', 'sId', 'zhId', 'ownerName', 'roomNo', 'address', 'feeCode', 'feeName', 'natureCode', 'period', 'amountCents', 'paidDate', 'refundDate', 'bookDate', 'adjustDate', 'changeDate', 'tradeOrderNo', 'merchantOrderNo', 'paymentMethod', 'cashier', 'incomeCents', 'receiptWarehouseNo', 'invoiceNo', 'receiptVoucherNo', 'sourceUpdatedAt'];
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const row of rows) {
      const placeholders = fields.map((field) => {
        values.push(row[field] ?? null);
        return `$${values.length}`;
      });
      tuples.push(`(${placeholders.join(',')})`);
    }
    await this.dataSource.query(
      `INSERT INTO mis_mirror_bill(zj_id,office_code,l_id,s_id,zh_id,owner_name,room_no,address,fee_code,fee_name,nature_code,period,amount_cents,paid_date,refund_date,book_date,adjust_date,change_date,trade_order_no,merchant_order_no,payment_method,cashier,income_cents,receipt_warehouse_no,invoice_no,receipt_voucher_no,source_updated_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (zj_id) DO UPDATE SET
         office_code=EXCLUDED.office_code,l_id=EXCLUDED.l_id,s_id=EXCLUDED.s_id,zh_id=EXCLUDED.zh_id,
         owner_name=EXCLUDED.owner_name,room_no=EXCLUDED.room_no,address=EXCLUDED.address,
         fee_code=EXCLUDED.fee_code,fee_name=EXCLUDED.fee_name,nature_code=EXCLUDED.nature_code,period=EXCLUDED.period,
         amount_cents=EXCLUDED.amount_cents,paid_date=EXCLUDED.paid_date,refund_date=EXCLUDED.refund_date,
         book_date=EXCLUDED.book_date,adjust_date=EXCLUDED.adjust_date,change_date=EXCLUDED.change_date,
         trade_order_no=EXCLUDED.trade_order_no,merchant_order_no=EXCLUDED.merchant_order_no,
         payment_method=EXCLUDED.payment_method,cashier=EXCLUDED.cashier,
         income_cents=EXCLUDED.income_cents,receipt_warehouse_no=EXCLUDED.receipt_warehouse_no,
         invoice_no=EXCLUDED.invoice_no,receipt_voucher_no=EXCLUDED.receipt_voucher_no,
         source_updated_at=EXCLUDED.source_updated_at,synced_at=now()`,
      values,
    );
  }

  private async syncSmallDimensions() {
    const [fees, methods, offices] = await Promise.all([
      this.misFees.mirrorRead(
        `SELECT DH AS feeCode,COALESCE(NULLIF(显示名称,N''),XM) AS feeName,收费类别 AS category FROM dbo.SETUPSFXM`,
        {},
        MIS_TIMEOUT,
      ),
      this.misFees.mirrorRead('SELECT id AS methodId,收款方式 AS methodName FROM dbo.收款方式列表', {}, MIS_TIMEOUT),
      this.misFees.mirrorRead('SELECT DISTINCT 管理处 AS officeCode FROM dbo.楼表', {}, MIS_TIMEOUT),
    ]);
    const feeRows = (fees?.recordsets?.[0] ?? []) as any[];
    const methodRows = (methods?.recordsets?.[0] ?? []) as any[];
    const officeRows = (offices?.recordsets?.[0] ?? []) as any[];
    for (const row of feeRows) {
      await this.dataSource.query(
        `INSERT INTO mis_mirror_fee_item(fee_code,fee_name,category,synced_at) VALUES($1,$2,$3,now())
         ON CONFLICT (fee_code) DO UPDATE SET fee_name=EXCLUDED.fee_name,category=EXCLUDED.category,synced_at=now()`,
        [String(row.feeCode), String(row.feeName ?? ''), row.category == null ? null : String(row.category)],
      );
    }
    for (const row of methodRows) {
      await this.dataSource.query(
        `INSERT INTO mis_mirror_payment_method(method_id,method_name,synced_at) VALUES($1,$2,now())
         ON CONFLICT (method_id) DO UPDATE SET method_name=EXCLUDED.method_name,synced_at=now()`,
        [Number(row.methodId), String(row.methodName ?? '')],
      );
    }
    for (const row of officeRows) {
      await this.dataSource.query(
        `INSERT INTO mis_mirror_offices(office_code,synced_at) VALUES($1,now())
         ON CONFLICT (office_code) DO UPDATE SET synced_at=now()`,
        [String(row.officeCode ?? '')],
      );
    }
  }

  /**
   * P4-A 补充镜像：票据/开票数据/核销记录/签报情况/签报减免。
   *
   * 5 张表都是小表（生产：票据 588、开票数据 597、核销 0、签报 23、减免 19），
   * 源表没有可靠增量时间字段，因此每轮 5 分钟全量 upsert（按源主键幂等）。
   * 每张表单独 try/catch，失败只写 mis_sync_state.last_error，不影响账单与其它表。
   */
  async syncExtraMirrors(tenantId: number): Promise<{ synced: number; failed: string[] }> {
    const specs: Array<{
      source: string;
      table: string;
      conflict: string;
      columns: Array<[string, string]>;
      sql: string;
    }> = [
      {
        source: 'ticket',
        table: 'mis_mirror_ticket',
        conflict: 'id',
        columns: [
          ['id', 'id'], ['ticket_no', 'ticketNo'], ['warehouse_no', 'warehouseNo'], ['office_code', 'officeCode'],
          ['issue_date', 'issueDate'], ['payer', 'payer'], ['amount_cents', 'amountCents'], ['tax_cents', 'taxCents'],
          ['pre_issue', 'preIssue'], ['receipt_date', 'receiptDate'], ['issuer', 'issuer'], ['payee', 'payee'],
          ['void_date', 'voidDate'], ['void_reason', 'voidReason'], ['writeoff_date', 'writeoffDate'],
          ['payment_method', 'paymentMethod'], ['refund_date', 'refundDate'], ['zh_id', 'zhId'],
          ['customer_name', 'customerName'], ['address', 'address'], ['invoice_no', 'invoiceNo'],
          ['invoice_code', 'invoiceCode'], ['type', 'type'], ['source_updated_at', 'sourceUpdatedAt'],
        ],
        sql: `SELECT ID AS id, 票据编号 AS ticketNo, 入库单编号 AS warehouseNo, 管理处 AS officeCode,
            CONVERT(varchar(10),开票日期,23) AS issueDate, 付款人 AS payer,
            CAST(ROUND(ISNULL(金额,0)*100,0) AS bigint) AS amountCents,
            CAST(ROUND(ISNULL(税额,0)*100,0) AS bigint) AS taxCents,
            CONVERT(bit,ISNULL(预开,0)) AS preIssue, CONVERT(varchar(10),收款日期,23) AS receiptDate,
            开票人 AS issuer, 收款人 AS payee, CONVERT(varchar(10),作废日期,23) AS voidDate,
            作废原因 AS voidReason, CONVERT(varchar(10),核销日期,23) AS writeoffDate,
            收款方式 AS paymentMethod, CONVERT(varchar(10),退款日期,23) AS refundDate,
            ZH_ID AS zhId, 购方名称 AS customerName, 地址 AS address, 发票流水号 AS invoiceNo,
            发票代码 AS invoiceCode, CAST(NULL AS varchar(60)) AS type, CAST(NULL AS varchar(19)) AS sourceUpdatedAt
          FROM [票据] WHERE ID IS NOT NULL`,
      },
      {
        source: 'ticket_item',
        table: 'mis_mirror_ticket_item',
        conflict: 'id',
        columns: [
          ['id', 'id'], ['ticket_id', 'ticketId'], ['ticket_no', 'ticketNo'], ['item_name', 'itemName'],
          ['project', 'project'], ['amount_cents', 'amountCents'], ['tax_cents', 'taxCents'], ['fee_code', 'feeCode'],
          ['warehouse_no', 'warehouseNo'], ['receipt_voucher_no', 'receiptVoucherNo'], ['non_daily', 'nonDaily'],
          ['tax_rate', 'taxRate'],
        ],
        sql: `SELECT ID AS id, 票据id AS ticketId, 票据编号 AS ticketNo, 品名 AS itemName, 项目 AS project,
            CAST(ROUND(ISNULL(金额,0)*100,0) AS bigint) AS amountCents,
            CAST(ROUND(ISNULL(税额,0)*100,0) AS bigint) AS taxCents,
            收费项目代号 AS feeCode, 入库单编号 AS warehouseNo, 收款凭证编号 AS receiptVoucherNo,
            CONVERT(bit,ISNULL(非日常,0)) AS nonDaily, 税率 AS taxRate
          FROM [票据开票数据] WHERE ID IS NOT NULL`,
      },
      {
        source: 'ticket_writeoff',
        table: 'mis_mirror_ticket_writeoff',
        conflict: 'id',
        columns: [
          ['id', 'id'], ['writeoff_no', 'writeoffNo'], ['office_code', 'officeCode'],
          ['writeoff_date', 'writeoffDate'], ['quantity', 'quantity'], ['issued_qty', 'issuedQty'],
          ['void_qty', 'voidQty'], ['pre_issue_qty', 'preIssueQty'], ['unused_qty', 'unusedQty'],
          ['issued_amount_cents', 'issuedAmountCents'], ['pre_issue_amount_cents', 'preIssueAmountCents'],
          ['writeoff_user', 'writeoffUser'],
        ],
        sql: `SELECT ID AS id, 核销记录编号 AS writeoffNo, 核销部门代号 AS officeCode,
            CONVERT(varchar(10),核销日期,23) AS writeoffDate, 核销数量 AS quantity, 已开数量 AS issuedQty,
            作废数量 AS voidQty, 预开数量 AS preIssueQty, 未用数 AS unusedQty,
            CAST(ROUND(ISNULL(开票金额,0)*100,0) AS bigint) AS issuedAmountCents,
            CAST(ROUND(ISNULL(预开金额,0)*100,0) AS bigint) AS preIssueAmountCents, 核销人 AS writeoffUser
          FROM [票据核销记录] WHERE ID IS NOT NULL`,
      },
      {
        source: 'signoff',
        table: 'mis_mirror_signoff',
        conflict: 'id',
        columns: [
          ['id', 'id'], ['doc_no', 'docNo'], ['title', 'title'], ['type', 'type'], ['detail', 'detail'],
          ['office_code', 'officeCode'], ['reason', 'reason'], ['zh_id', 'zhId'], ['draft_date', 'draftDate'],
          ['approve_date', 'approveDate'], ['result', 'result'], ['voided', 'voided'], ['ended', 'ended'],
          ['adjust_amount_cents', 'adjustAmountCents'], ['fee_code', 'feeCode'], ['nature', 'nature'],
          ['source_updated_at', 'sourceUpdatedAt'],
        ],
        sql: `SELECT ID AS id, 文号字 AS docNo, 签报标题 AS title, 签报类型 AS type, 类型详细 AS detail,
            管理处 AS officeCode, 签报事由 AS reason, ZH_ID AS zhId,
            CONVERT(varchar(10),拟稿日期,23) AS draftDate, CONVERT(varchar(10),审批日期,23) AS approveDate,
            结果 AS result, CONVERT(bit,ISNULL(作废,0)) AS voided, CONVERT(bit,ISNULL(结束,0)) AS ended,
            CAST(ROUND(ISNULL(调整金额,0)*100,0) AS bigint) AS adjustAmountCents,
            收费项目 AS feeCode, 房屋性质 AS nature, CONVERT(varchar(19),数据修改日期,126) AS sourceUpdatedAt
          FROM [签报情况表] WHERE ID IS NOT NULL`,
      },
      {
        source: 'relief',
        table: 'mis_mirror_relief',
        conflict: 'id',
        columns: [
          ['id', 'id'], ['doc_no', 'docNo'], ['zh_id', 'zhId'], ['fee_code', 'feeCode'],
          ['fee_name', 'feeName'], ['old_receivable_cents', 'oldReceivableCents'],
          ['receivable_cents', 'receivableCents'], ['relief_cents', 'reliefCents'],
          ['relief_start_date', 'reliefStartDate'], ['relief_end_date', 'reliefEndDate'],
          ['relief_date', 'reliefDate'], ['method', 'method'],
        ],
        sql: `SELECT ID AS id, 文号 AS docNo, ZH_ID AS zhId, 项目代号 AS feeCode, 项目名称 AS feeName,
            CAST(ROUND(ISNULL(OLD应收金额,0)*100,0) AS bigint) AS oldReceivableCents,
            CAST(ROUND(ISNULL(应收金额,0)*100,0) AS bigint) AS receivableCents,
            CAST(ROUND(ISNULL(减免金额,0)*100,0) AS bigint) AS reliefCents,
            CONVERT(varchar(10),减免开始日期,23) AS reliefStartDate,
            CONVERT(varchar(10),减免结束日期,23) AS reliefEndDate,
            CONVERT(varchar(10),减免日期,23) AS reliefDate, 减免方式 AS method
          FROM [签报减免信息] WHERE ID IS NOT NULL`,
      },
    ];
    let synced = 0;
    const failed: string[] = [];
    for (const spec of specs) {
      try {
        const result = await this.misFees.mirrorRead(spec.sql, {}, MIS_TIMEOUT);
        const sourceRows = (result?.recordsets?.[0] ?? []) as any[];
        const affected = await this.upsertMirrorRows(spec.table, spec.conflict, spec.columns, sourceRows);
        synced += affected;
        await this.dataSource.query(
          `INSERT INTO mis_sync_state(tenant_id,source_table,last_success_at,last_attempt_at,last_error,initialized_at,synced_rows)
           VALUES($1,$2,now(),now(),NULL,now(),$3)
           ON CONFLICT (tenant_id,source_table) DO UPDATE SET
             last_success_at=now(),last_attempt_at=now(),last_error=NULL,
             initialized_at=COALESCE(mis_sync_state.initialized_at,now()),synced_rows=EXCLUDED.synced_rows`,
          [tenantId, spec.source, sourceRows.length],
        );
      } catch (error) {
        failed.push(spec.source);
        await this.recordSyncError(tenantId, spec.source, error).catch(() => 0);
        this.logger.warn(`MIS 补充镜像 ${spec.source} 同步失败：${(error as Error).message}`);
      }
    }
    return { synced, failed };
  }

  /** 通用小表全量 upsert（列名/表名为内部常量，不做外部拼接）。 */
  private async upsertMirrorRows(
    table: string,
    conflict: string,
    columns: Array<[string, string]>,
    rows: any[],
  ): Promise<number> {
    if (!rows.length) return 0;
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const row of rows) {
      const placeholders = columns.map(([, field]) => {
        values.push(row[field] ?? null);
        return `$${values.length}`;
      });
      tuples.push(`(${placeholders.join(',')},now())`);
    }
    const columnNames = columns.map(([column]) => column).join(',');
    const updates = columns
      .filter(([column]) => column !== conflict)
      .map(([column]) => `${column}=EXCLUDED.${column}`)
      .join(',');
    await this.dataSource.query(
      `INSERT INTO ${table}(${columnNames},synced_at) VALUES ${tuples.join(',')}
       ON CONFLICT (${conflict}) DO UPDATE SET ${updates},synced_at=now()`,
      values,
    );
    return rows.length;
  }


  /**
   * 手工全量重灌：先维度后账单，按 ZJ_ID keyset 分批 500。
   * 只允许管理员触发；不在定时任务里调用。完成后顺带同步 P4-A 补充镜像。
   */
  async reloadAll(tenantId: number) {
    const lock = await this.dataSource.query(`SELECT pg_try_advisory_lock(hashtext('mis-mirror-sync')) AS ok`);
    if (!lock?.[0]?.ok) throw new BadRequestException('镜像同步正在运行，请稍后再试');
    try {
      // 部署代码不代表已执行手工迁移：先检查目标列，避免带着旧结构访问 MIS 后才失败。
      try {
        await this.dataSource.query('SELECT owner_note,move_in_date,billing_start_date FROM mis_mirror_owner LIMIT 0');
        await this.dataSource.query('SELECT wy_dj_id,zh_id,zl_id,fee_code,je,bz,is_history FROM mis_mirror_charge_standard LIMIT 0');
      } catch (error) {
        const code = String((error as { code?: unknown })?.code ?? '');
        if (code === '42703' || code === '42P01') {
          throw new ServiceUnavailableException('业主/收费标准镜像结构尚未就绪，请先完成镜像迁移（含 1795600000000、1795700000000）后重试');
        }
        throw error;
      }
      const buildings = dimensionMirrorRows(await this.misFees.mirrorRead('SELECT CONVERT(varchar(20),L_ID) AS lId,管理处 AS officeCode,地址1 AS road,地址2 AS lane,地址3 AS buildingNo FROM dbo.楼表', {}, MIS_TIMEOUT), '楼表');
      const rooms = dimensionMirrorRows(await this.misFees.mirrorRead('SELECT CONVERT(varchar(20),S_ID) AS sId,CONVERT(varchar(20),L_ID) AS lId,室 AS roomNo,房屋性质 AS nature,建筑面积 AS areaSqm FROM dbo.室表', {}, MIS_TIMEOUT), '室表');
      const owners = dimensionMirrorRows(await this.misFees.mirrorRead(`SELECT CONVERT(varchar(20),ZH_ID) AS zhId,CONVERT(varchar(20),S_ID) AS sId,姓名 AS name,
        移动电话 AS mobile,固定电话 AS phone2,说明 AS ownerNote,
        CONVERT(varchar(10),进户日期,23) AS moveInDate,
        CONVERT(varchar(10),开始收费日期,23) AS billingStartDate,
        updatedate AS sourceUpdatedAt FROM dbo.业主表`, {}, MIS_TIMEOUT), '业主表');
      // 仅既有管理员手工重灌读取 WYDJ；定时账单同步不读取/初始化此镜像。
      const standardResult = await this.misFees.mirrorRead(`SELECT
        CONVERT(varchar(20),ID) AS standardId,CONVERT(varchar(20),ZH_ID) AS zhId,
        CONVERT(varchar(20),ZL_ID) AS zlId,DH AS feeCode,
        CONVERT(varchar(40),JE,2) AS je,CONVERT(varchar(40),BZ,2) AS bz,Histroy AS isHistory
        FROM dbo.WYDJ`, {}, MIS_TIMEOUT);
      const standardRows = standardResult?.recordsets?.[0];
      if (!Array.isArray(standardRows)) throw new ServiceUnavailableException('WYDJ 收费标准源未返回结果集，未更新镜像');
      const standards = standardRows.map(chargeStandardMirrorParams);
      await this.dataSource.transaction(async (manager) => {
        await manager.query('DELETE FROM mis_mirror_building');
        await manager.query('DELETE FROM mis_mirror_room');
        await manager.query('DELETE FROM mis_mirror_owner');
        await manager.query('DELETE FROM mis_mirror_charge_standard');
        for (const row of buildings as any[]) await manager.query(
          `INSERT INTO mis_mirror_building(l_id,office_code,road,lane,building_no,synced_at) VALUES($1,$2,$3,$4,$5,now())`,
          [row.lId, row.officeCode, row.road ?? null, row.lane ?? null, row.buildingNo ?? null],
        );
        for (const row of rooms as any[]) await manager.query(
          `INSERT INTO mis_mirror_room(s_id,l_id,room_no,nature,area_sqm,synced_at) VALUES($1,$2,$3,$4,$5,now())`,
          [row.sId, row.lId ?? null, row.roomNo ?? '', row.nature ?? null, row.areaSqm ?? null],
        );
        for (const row of owners as any[]) await manager.query(
          `INSERT INTO mis_mirror_owner(zh_id,s_id,name,mobile,phone2,source_updated_at,owner_note,move_in_date,billing_start_date,synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [row.zhId, row.sId ?? null, row.name ?? null, row.mobile ?? null, row.phone2 ?? null, row.sourceUpdatedAt ?? null,
            row.ownerNote ?? null, row.moveInDate ?? null, row.billingStartDate ?? null],
        );
        for (const values of standards) await manager.query(
          `INSERT INTO mis_mirror_charge_standard(wy_dj_id,zh_id,zl_id,fee_code,je,bz,is_history,synced_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now())`, values,
        );
        await manager.query(
          `INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at,last_attempt_at,last_success_at,synced_rows)
           VALUES($1,'charge_standard',now(),now(),now(),$2)
           ON CONFLICT (tenant_id,source_table) DO UPDATE SET initialized_at=now(),last_attempt_at=now(),
             last_success_at=now(),last_error=NULL,lag_rows=0,synced_rows=EXCLUDED.synced_rows`,
          [tenantId, standards.length],
        );
      });
      await this.syncSmallDimensions();
      await this.dataSource.query(
        `INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at,last_attempt_at)
         VALUES($1,'bill',now(),now())
         ON CONFLICT (tenant_id,source_table) DO UPDATE SET initialized_at=now(),last_attempt_at=now(),last_error=NULL`,
        [tenantId],
      );
      let lastId = '0';
      let total = 0;
      for (;;) {
        const batch = billMirrorRows(await this.misFees.mirrorRead(
          `SELECT TOP (@take) CONVERT(varchar(20),w.ZJ_ID) AS zjId, l.管理处 AS officeCode, CONVERT(varchar(20),l.L_ID) AS lId, CONVERT(varchar(20),s.S_ID) AS sId, CONVERT(varchar(20),z.ZH_ID) AS zhId,
             z.姓名 AS ownerName, s.室 AS roomNo,
             ISNULL(l.地址1,N'')+ISNULL(l.字1,N'')+ISNULL(l.地址2,N'')+ISNULL(l.字2,N'')+ISNULL(l.地址3,N'')+ISNULL(l.字3,N'')+ISNULL(l.地址4,N'')+ISNULL(l.字4,N'')+ISNULL(s.室,N'')+ISNULL(s.字,N'') AS address,
             w.ZJ_LX AS feeCode, f.XM AS feeName, w.FWXZ_DH AS natureCode, w.ZJ_CNY AS period, CAST(ROUND(w.ZJ_JE*100,0) AS bigint) AS amountCents,
             CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidDate, CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundDate,
             CONVERT(varchar(10),w.ZJ_Jzrq,23) AS bookDate, CONVERT(varchar(10),w.ZJ_TZRQ,23) AS adjustDate, CONVERT(varchar(10),w.ZJ_Bdrq,23) AS changeDate,
             w.交易订单号 AS tradeOrderNo, w.商户订单号 AS merchantOrderNo,
             COALESCE(NULLIF(w.收款方式,N''),m.收款方式) AS paymentMethod, w.收款人 AS cashier,
             CAST(ROUND(ISNULL(w.收入,0)*100,0) AS bigint) AS incomeCents,
             w.票据入库单编号 AS receiptWarehouseNo, w.发票号码 AS invoiceNo, w.凭证号码 AS receiptVoucherNo,
             CONVERT(varchar(19),w.updatedate,126) AS sourceUpdatedAt           FROM dbo.WYZJ w
           INNER JOIN dbo.业主表 z ON z.ZH_ID=w.ZH_ID
           INNER JOIN dbo.室表 s ON s.S_ID=z.S_ID
           INNER JOIN dbo.楼表 l ON l.L_ID=s.L_ID
           LEFT JOIN dbo.SETUPSFXM f ON f.DH=w.ZJ_LX
           LEFT JOIN dbo.收款方式列表 m ON m.id=w.收款方式ID
           WHERE w.ZJ_ID > @lastId AND ISNULL(w.SC,N'0')=N'0'
           ORDER BY w.ZJ_ID`,
          { take: BATCH_SIZE, lastId }, MIS_TIMEOUT,
        ), lastId);
        await this.upsertBills(batch as any[]);
        total += batch.length;
        if (!batch.length) break;
        lastId = batch[batch.length - 1].zjId;
        if (batch.length < BATCH_SIZE) break;
      }
      const last = await this.dataSource.query(
        `SELECT MAX(source_updated_at) AS lastUpdated,MAX(zj_id)::text AS lastId FROM mis_mirror_bill`,
      );
      await this.dataSource.query(
        `UPDATE mis_sync_state SET last_updated_at=$2,last_id=$3,last_success_at=now(),last_error=NULL,lag_rows=0,synced_rows=$4
          WHERE tenant_id=$1 AND source_table='bill'`,
        [tenantId, last[0]?.lastupdated ?? null, last[0]?.lastid ?? null, total],
      );
      const extra = await this.syncExtraMirrors(tenantId);
      return { rows: total, extra, chargeStandardRows: standards.length };
    } finally {
      await this.dataSource.query(`SELECT pg_advisory_unlock(hashtext('mis-mirror-sync'))`).catch(() => undefined);
    }
  }

  private async recordSyncError(tenantId: number, source: string, error: unknown): Promise<number> {
    const result: any[] = await this.dataSource.query(
      `INSERT INTO mis_sync_state(tenant_id,source_table,last_attempt_at,last_error,consecutive_failures,last_failure_at)
       VALUES($1,$2,now(),$3,1,now())
       ON CONFLICT (tenant_id,source_table) DO UPDATE SET
         last_attempt_at=now(),last_error=EXCLUDED.last_error,
         consecutive_failures=COALESCE(mis_sync_state.consecutive_failures,0)+1,last_failure_at=now()
       RETURNING consecutive_failures`,
      [tenantId, source, String((error as Error)?.message ?? error).slice(0, 500)],
    );
    return Number(result[0]?.consecutive_failures || 1);
  }

  private misDateTime(value: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  }

  // ---------------- 镜像读路径 ----------------

  private async communities(q: any, user: AuthUser, access?: ResolvedAccess): Promise<MirrorCommunity[]> {
    const communities = await this.misFees.residentialScope(q, user, access);
    return communities.map((community) => ({ id: community.id, name: community.name, offices: community.offices }));
  }

  private async buildWhere(q: any, offices: string[]) {
    const params: unknown[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const clauses = [`office_code IN (${offices.map((office) => add(office)).join(',')})`];
    if (q.periodFrom) clauses.push(`period >= ${add(q.periodFrom)}`);
    if (q.periodTo) clauses.push(`period <= ${add(q.periodTo)}`);
    if (q.feeCode) clauses.push(`fee_code = ${add(String(q.feeCode).replace(/^mis:/, ''))}`);
    if (q.paidFrom) clauses.push(`paid_date >= ${add(q.paidFrom)}`);
    if (q.paidTo) clauses.push(`paid_date <= ${add(q.paidTo)}`);
    if (q.q?.trim()) {
      const value = `%${String(q.q).trim()}%`;
      clauses.push(`(owner_name ILIKE ${add(value)} OR address ILIKE ${add(value)} OR room_no ILIKE ${add(value)})`);
    }
    return { where: clauses.join(' AND '), params };
  }

  private categorySql = misFeeCategorySql('fee_name');

  async residential(q: any, user: AuthUser, access?: ResolvedAccess) {
    if (!['dashboard', 'households', 'amount-brackets', 'communities', 'trend', 'detail'].includes(q.view || 'dashboard')) {
      throw new BadRequestException('镜像模式暂不支持该视图，请先切回 MIS 直连');
    }
    const communities = await this.communities(q, user, access);
    const offices = [...new Set(communities.flatMap((community) => community.offices))];
    const tenantId = Number(user.tenantId);
    const asOf = await this.assertReady(tenantId);
    const meta = { source: 'mirror', sourceLabel: 'MIS 镜像', readOnly: true, queriedAt: new Date().toISOString(), dataAsOf: asOf, communities };
    if (q.view === 'communities') {
      const rows = [] as any[];
      for (const community of communities) {
        const one = await this.residential({ ...q, view: 'dashboard', communityId: community.id }, user, access) as any;
        const sum = one.summary || {};
        rows.push({ id: community.id, name: community.name, receivableCents: Number(sum.receivableCents || 0), paidCents: Number(sum.paidCents || 0), unpaidCents: Number(sum.unpaidCents || 0), unpaidHouses: Number(sum.unpaidHouses || 0), rate: Number(sum.receivableCents) > 0 ? Math.round((Number(sum.netPaidCents ?? sum.paidCents) / Number(sum.receivableCents)) * 1000) / 10 : null });
      }
      rows.sort((a, b) => b.unpaidCents - a.unpaidCents);
      return { ...meta, rows };
    }
    const built = await this.buildWhere(q, offices);
    if (q.view === 'trend') {
      if (!q.paidFrom || !q.paidTo) throw new BadRequestException('趋势需指定收款日期范围');
      const from = Date.parse(`${q.paidFrom}T00:00:00+08:00`), to = Date.parse(`${q.paidTo}T00:00:00+08:00`);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new BadRequestException('收款日期范围不合法');
      if ((to - from) / 86400000 > 366) throw new BadRequestException('收款日期范围不能超过一年');
      const bucket = q.bucket === 'month' ? 'month' : 'day';
      const params = [...built.params];
      const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
      const fromParam = add(q.paidFrom), toParam = add(q.paidTo);
      const category = this.categoryFilter(q, params);
      const key = bucket === 'month' ? `to_char(paid_date,'YYYY-MM')` : `to_char(paid_date,'YYYY-MM-DD')`;
      const refundKey = bucket === 'month' ? `to_char(refund_date,'YYYY-MM')` : `to_char(refund_date,'YYYY-MM-DD')`;
      const rows: any[] = await this.dataSource.query(
        `WITH flows AS (
           SELECT ${key} AS key,amount_cents AS amount,0 AS refund
             FROM mis_mirror_bill
            WHERE ${built.where} AND ${category} AND amount_cents>=0 AND paid_date>=${fromParam}::date AND paid_date<(${toParam}::date + INTERVAL '1 day')
           UNION ALL
           SELECT ${refundKey} AS key,-amount_cents AS amount,1 AS refund
             FROM mis_mirror_bill
            WHERE ${built.where} AND ${category} AND amount_cents>=0 AND paid_date IS NOT NULL AND refund_date>=${fromParam}::date AND refund_date<(${toParam}::date + INTERVAL '1 day')
         )
         SELECT key,COALESCE(SUM(amount),0)::bigint AS "netCents",
                COALESCE(SUM(CASE WHEN refund=0 THEN amount ELSE 0 END),0)::bigint AS "chargedCents",
                COALESCE(SUM(CASE WHEN refund=1 THEN -amount ELSE 0 END),0)::bigint AS "refundedCents"
           FROM flows GROUP BY key ORDER BY key`,
        params,
      );
      return { ...meta, bucket, invalidDateCount: 0, rows: rows.map((row) => bucket === 'month'
        ? { month: String(row.key), netCents: Number(row.netCents), chargedCents: Number(row.chargedCents), refundedCents: Number(row.refundedCents) }
        : { day: String(row.key), netCents: Number(row.netCents), chargedCents: Number(row.chargedCents), refundedCents: Number(row.refundedCents) }) };
    }
    if (q.view === 'detail') {
      if (!q.houseKeys?.length) throw new BadRequestException('请先选择住户');
      if (q.houseKeys.length > 200) throw new BadRequestException('每批最多200户，请按楼栋分批');
      const keys: any[] = [...new Set(q.houseKeys.map((key: string) => {
        const m = /^(0[1-4]):([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(String(key));
        if (!m || !offices.includes(m[1])) throw new BadRequestException('所选住户不在查询范围');
        return { office: m[1], sid: Number(m[2]), zhid: Number(m[3]), raw: m[0] };
      }))];
      const params = [...built.params];
      const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
      const predicates = keys.map((key) => `(office_code=${add(key.office)} AND s_id=${add(key.sid)} AND zh_id=${add(key.zhid)})`);
      const category = this.categoryFilter(q, params);
      const status = q.status === 'paid' ? 'paid_date IS NOT NULL' : 'paid_date IS NULL';
      const rows: any[] = await this.dataSource.query(
        `SELECT zj_id AS id,office_code AS "officeCode",s_id AS "sId",zh_id AS "zhId",address,owner_name AS "ownerName",
                fee_code AS "feeCode",fee_name AS "feeName",period,amount_cents AS "amountCents",paid_date AS "paidDate",
                source_updated_at AS "updatedAt"
           FROM mis_mirror_bill
          WHERE ${built.where} AND ${category} AND refund_date IS NULL AND amount_cents>0 AND ${status} AND (${predicates.join(' OR ')})
          ORDER BY address,period,fee_code,zj_id LIMIT 10001`,
        params,
      );
      if (rows.length > 10000) throw new BadRequestException('账单明细超过一万条，请缩小账期或分批');
      return { ...meta, rows: rows.map((row) => {
        const community = communities.find((item) => item.offices.includes(String(row.officeCode)));
        const paidAt = row.paidDate ? (row.paidDate instanceof Date
          ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(row.paidDate)
          : String(row.paidDate).slice(0, 10)) : null;
        return { houseKey: `${row.officeCode}:${row.sId}:${row.zhId}`, id: String(row.id), officeCode: String(row.officeCode), address: String(row.address || ''), ownerName: String(row.ownerName || ''), feeCode: row.feeCode, feeName: row.feeName || '未命名费项', period: row.period, amountCents: Number(row.amountCents || 0), billCount: 1, paidAt, updatedAt: row.updatedAt ? String(row.updatedAt) : null, communityId: community?.id, phone: undefined, phoneMasked: '未留手机号', contactEligible: false };
      }) };
    }
    if (q.view === 'amount-brackets') {
      const rows: any[] = await this.dataSource.query(
        `WITH per_house AS (
           SELECT office_code, s_id, zh_id, SUM(amount_cents) AS unpaid
             FROM mis_mirror_bill
            WHERE ${built.where} AND paid_date IS NULL AND refund_date IS NULL AND amount_cents > 0
            GROUP BY office_code, s_id, zh_id
         )
         SELECT CASE WHEN unpaid<=50000 THEN 'le500' WHEN unpaid<=200000 THEN '500to2000' WHEN unpaid<=500000 THEN '2000to5000' ELSE 'gt5000' END AS "bucketKey",
                COUNT(*)::int AS "houseCount", SUM(unpaid)::bigint AS "amountCents"
           FROM per_house GROUP BY 1 ORDER BY 1`,
        built.params,
      );
      const byKey = new Map(rows.map((row) => [row.bucketKey, row]));
      const buckets = [
        { key: 'le500', label: '≤¥500' },
        { key: '500to2000', label: '¥500–2000' },
        { key: '2000to5000', label: '¥2000–5000' },
        { key: 'gt5000', label: '>¥5000' },
      ].map((bucket) => ({ ...bucket, count: Number(byKey.get(bucket.key)?.houseCount || 0), amountCents: Number(byKey.get(bucket.key)?.amountCents || 0) }));
      return { ...meta, buckets, total: { count: buckets.reduce((sum, bucket) => sum + bucket.count, 0), amountCents: buckets.reduce((sum, bucket) => sum + bucket.amountCents, 0) } };
    }
    if (q.view === 'dashboard' || !q.view) {
      const summaryRows: any[] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(CASE WHEN refund_date IS NULL AND amount_cents>=0 THEN amount_cents ELSE 0 END),0)::bigint AS "receivableCents",
                COALESCE(SUM(CASE WHEN paid_date IS NOT NULL AND refund_date IS NULL AND amount_cents>=0 THEN amount_cents ELSE 0 END),0)::bigint AS "paidCents",
                COALESCE(SUM(CASE WHEN paid_date IS NULL AND refund_date IS NULL AND amount_cents>0 THEN amount_cents ELSE 0 END),0)::bigint AS "unpaidCents",
                COALESCE(SUM(CASE WHEN refund_date IS NULL AND amount_cents<0 THEN amount_cents ELSE 0 END),0)::bigint AS "adjustmentCents",
                COUNT(DISTINCT CASE WHEN paid_date IS NULL AND refund_date IS NULL AND amount_cents>0 THEN office_code||':'||s_id END)::int AS "unpaidHouses",
                SUM(CASE WHEN amount_cents<0 THEN 1 ELSE 0 END)::int AS "adjustmentCount"
           FROM mis_mirror_bill WHERE ${built.where}`,
        built.params,
      );
      const byFee: any[] = await this.dataSource.query(
        `SELECT fee_code AS "feeCode",fee_name AS "feeName",${this.categorySql} AS category,
                COALESCE(SUM(CASE WHEN refund_date IS NULL AND amount_cents>=0 THEN amount_cents ELSE 0 END),0)::bigint AS "receivableCents",
                COALESCE(SUM(CASE WHEN paid_date IS NOT NULL AND refund_date IS NULL AND amount_cents>=0 THEN amount_cents ELSE 0 END),0)::bigint AS "paidCents",
                COALESCE(SUM(CASE WHEN paid_date IS NULL AND refund_date IS NULL AND amount_cents>0 THEN amount_cents ELSE 0 END),0)::bigint AS "unpaidCents",
                COALESCE(SUM(CASE WHEN refund_date IS NULL AND amount_cents<0 THEN amount_cents ELSE 0 END),0)::bigint AS "adjustmentCents",
                COUNT(DISTINCT CASE WHEN paid_date IS NULL AND refund_date IS NULL AND amount_cents>0 THEN office_code||':'||s_id END)::int AS "unpaidHouses"
           FROM mis_mirror_bill WHERE ${built.where} GROUP BY fee_code,fee_name,${this.categorySql} ORDER BY "unpaidCents" DESC`,
        built.params,
      );
      const adj=Number(summaryRows[0]?.adjustmentCents||0),paid=Number(summaryRows[0]?.paidCents||0);return { ...meta, summary: { receivableCents: Number(summaryRows[0]?.receivableCents || 0), paidCents: paid, unpaidCents: Number(summaryRows[0]?.unpaidCents || 0), total: Number(summaryRows[0]?.total || 0), unpaidHouses: Number(summaryRows[0]?.unpaidHouses || 0), adjustmentCount: Number(summaryRows[0]?.adjustmentCount || 0),adjustmentCents:adj,netPaidCents:paid+adj }, byFee: byFee.map((row) => {const p=Number(row.paidCents||0),a=Number(row.adjustmentCents||0);return { receivableCents: Number(row.receivableCents || 0), paidCents: p, unpaidCents: Number(row.unpaidCents || 0), adjustmentCents:a,netPaidCents:p+a, feeCode: row.feeCode, feeName: row.feeName || '未命名费项', category: row.category, unpaidHouses: Number(row.unpaidHouses || 0) };}) };
    }
    const status = q.status === 'paid' ? `paid_date IS NOT NULL AND refund_date IS NULL AND amount_cents>0` : `paid_date IS NULL AND refund_date IS NULL AND amount_cents>0`;
    const where = `${built.where} AND ${status} AND ${this.categoryFilter(q, built.params)}`;
    const totalRows: any[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(amount_cents),0)::bigint AS "amountCents" FROM (
         SELECT office_code,s_id,zh_id,SUM(amount_cents) AS amount_cents
           FROM mis_mirror_bill WHERE ${where} GROUP BY office_code,s_id,zh_id
       ) g`,
      built.params,
    );
    const page = Number(q.page || 1);
    const pageSize = Number(q.pageSize || 20);
    const offsetParam = `$${built.params.length + 1}`;
    const limitParam = `$${built.params.length + 2}`;
    const rows: any[] = await this.dataSource.query(
      `SELECT office_code AS "officeCode", s_id,zh_id,
              MAX(operation_address) AS address, MAX(owner_name) AS "ownerName", MAX(room_no) AS room,
              MAX(mobile) AS phone, COUNT(*)::int AS "billCount", SUM(amount_cents)::bigint AS "amountCents",
              MIN(period) AS "periodFrom", MAX(period) AS "periodTo"
         FROM (
           SELECT b.*, CONCAT(b.address,'') AS operation_address, o.mobile
             FROM mis_mirror_bill b LEFT JOIN mis_mirror_owner o ON o.zh_id=b.zh_id
            WHERE ${where}
         ) x
         GROUP BY office_code,s_id,zh_id
         ORDER BY address ASC, "amountCents" DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
      [...built.params, (page - 1) * pageSize, pageSize],
    );
    return { ...meta, total: Number(totalRows[0]?.total || 0), amountCents: Number(totalRows[0]?.amountCents || 0), page, pageSize, aging: undefined, rows: rows.map((row) => {
      const phone = String(row.phone || '').trim();
      const community = communities.find((item) => item.offices.includes(String(row.officeCode)));
      return { houseKey: `${row.officeCode}:${row.s_id}:${row.zh_id}`, address: String(row.address || ''), ownerName: String(row.ownerName || ''), phone: /^1[3-9]\d{9}$/.test(phone) ? phone : undefined, phoneMasked: /^1[3-9]\d{9}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone ? '号码待核实' : '未留手机号', contactEligible: /^1[3-9]\d{9}$/.test(phone), communityId: community?.id, billCount: Number(row.billCount || 0), amountCents: Number(row.amountCents || 0), periodFrom: row.periodFrom, periodTo: row.periodTo };
    }) };
  }

  private categoryFilter(q: any, params: unknown[]) {
    if (!q.category || q.category === 'all') return 'TRUE';
    return `${this.categorySql} = $${params.push(q.category)}`;
  }

  async syncAll() {
    const tenants: any[] = await this.dataSource.query(`SELECT id FROM tenants WHERE enabled=true ORDER BY id`).catch(() => []);
    let rows = 0;
    const failures: Array<{ tenantId: number; consecutiveFailures: number; lastError: string; lastSuccessAt: string | null }> = [];
    for (const tenant of tenants) {
      const result: any = await this.syncTick(Number(tenant.id));
      rows += result?.rows || 0;
      if (result?.failed) failures.push({ tenantId: Number(tenant.id), consecutiveFailures: Number(result.consecutiveFailures || 0), lastError: String(result.lastError || ''), lastSuccessAt: result.lastSuccessAt ?? null });
    }
    return { rows, tenants: tenants.length, failures };
  }

  async reconcileAll() {
    const tenants: any[] = await this.dataSource.query(`SELECT id FROM tenants WHERE enabled=true ORDER BY id`).catch(() => []);
    const results: any[] = [];
    for (const tenant of tenants) results.push(await this.reconcile(Number(tenant.id)));
    return results;
  }

  async metadata(user: AuthUser, access?: ResolvedAccess) {
    const asOf = await this.assertReady(Number(user.tenantId));
    const communities = await this.misFees.residentialScope({} as any, user, access);
    const feeItems: any[] = await this.dataSource.query(
      `SELECT fee_code AS code,fee_name AS name FROM mis_mirror_fee_item ORDER BY fee_code`,
    ).catch(() => []);
    return {
      available: true,
      readOnly: true,
      source: 'mirror',
      sourceLabel: 'MIS 镜像',
      dataAsOf: asOf,
      communities,
      feeItems,
      message: '读取 PMS 本地 MIS 镜像，不直连 MIS',
    };
  }

  /**
   * 每日对账：镜像账单条数/金额 vs MIS 源库；不一致写 system_logs 并告警。
   * 只读、低频率；不做定时全量重灌。
   */
  async reconcile(tenantId: number) {
    const offices = Object.values({ 枫桦景苑一期: ['01'], 枫桦景苑二期: ['02', '03'], 上海新家: ['04'] }).flat();
    const params: Record<string, string | number> = {};
    const officePlaceholders = offices.map((office, index) => { params[`office${index}`] = office; return `@office${index}`; }).join(',');
    const source: any = await this.misFees.mirrorRead(
      `SELECT COUNT_BIG(*) AS total,CONVERT(varchar(50),SUM(w.ZJ_JE*100),2) AS amount
         FROM dbo.WYZJ w
         INNER JOIN dbo.业主表 z ON z.ZH_ID=w.ZH_ID
         INNER JOIN dbo.室表 s ON s.S_ID=z.S_ID
         INNER JOIN dbo.楼表 l ON l.L_ID=s.L_ID
        WHERE l.管理处 IN (${officePlaceholders}) AND ISNULL(w.SC,N'0')=N'0'`,
      params, MIS_TIMEOUT,
    );
    const sourceRow = source?.recordsets?.[0]?.[0] || {};
    // 维度镜像（楼/室/业主）只在手工重灌时重建：每日对账同时比较维度行数，
    // 以及镜像内房号/地址的空白规模，避免“金额对得上但房号没同步”被当成正常。
    const dimensionSource: any = await this.misFees.mirrorRead(
      `SELECT (SELECT COUNT_BIG(*) FROM dbo.楼表) AS buildings,
              (SELECT COUNT_BIG(*) FROM dbo.室表) AS rooms,
              (SELECT COUNT_BIG(*) FROM dbo.业主表) AS owners`,
      {}, MIS_TIMEOUT,
    );
    const dimensionSourceRow = dimensionSource?.recordsets?.[0]?.[0] || {};
    const mirror: any[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total,COALESCE(SUM(amount_cents),0)::bigint AS amount FROM mis_mirror_bill`,
    );
    const dimensionMirror: any[] = await this.dataSource.query(
      `SELECT (SELECT COUNT(*)::int FROM mis_mirror_building) AS buildings,
              (SELECT COUNT(*)::int FROM mis_mirror_room) AS rooms,
              (SELECT COUNT(*)::int FROM mis_mirror_owner) AS owners,
              (SELECT COUNT(*)::int FROM mis_mirror_room WHERE room_no IS NULL OR room_no='') AS "roomsWithoutNo",
              (SELECT COUNT(*)::int FROM mis_mirror_bill WHERE address IS NULL OR address='') AS "billsWithoutAddress"`,
    );
    const totalDiff = Number(mirror[0]?.total || 0) - Number(sourceRow.total || 0);
    const amountDiff = Number(mirror[0]?.amount || 0) - Math.round(Number(sourceRow.amount || 0));
    const dimensionDiff = {
      buildings: Number(dimensionMirror[0]?.buildings || 0) - Number(dimensionSourceRow.buildings || 0),
      rooms: Number(dimensionMirror[0]?.rooms || 0) - Number(dimensionSourceRow.rooms || 0),
      owners: Number(dimensionMirror[0]?.owners || 0) - Number(dimensionSourceRow.owners || 0),
    };
    const dimensionMismatch = Object.values(dimensionDiff).some((diff) => diff !== 0);
    const ok = totalDiff === 0 && amountDiff === 0 && !dimensionMismatch;
    const quality = {
      roomsWithoutNo: Number(dimensionMirror[0]?.roomsWithoutNo || 0),
      billsWithoutAddress: Number(dimensionMirror[0]?.billsWithoutAddress || 0),
    };
    const problems = [
      totalDiff === 0 ? null : `记录差 ${totalDiff}`,
      amountDiff === 0 ? null : `金额差 ${amountDiff} 分`,
      dimensionMismatch ? `维度差 楼 ${dimensionDiff.buildings}、室 ${dimensionDiff.rooms}、业主 ${dimensionDiff.owners}（维度仅在手工重灌时重建，请重灌后复核）` : null,
    ].filter(Boolean);
    await this.dataSource.query(
      `INSERT INTO system_logs(tenant_id,category,level,source,action,success,message,detail,created_at,updated_at)
       VALUES($1,'alert',$2,'mis-mirror',$3,$4,$5,$6::jsonb,now(),now())`,
      [tenantId, ok ? 'info' : 'warning', 'mis_mirror_reconcile', ok,
        ok ? 'MIS 镜像对账一致' : `MIS 镜像不一致：${problems.join('；')}`,
        JSON.stringify({ sourceTotal: Number(sourceRow.total || 0), mirrorTotal: Number(mirror[0]?.total || 0), sourceAmountCents: Math.round(Number(sourceRow.amount || 0)), mirrorAmountCents: Number(mirror[0]?.amount || 0), totalDiff, amountDiff, dimensionDiff, quality })],
    ).catch(() => undefined);
    return {
      ok,
      sourceTotal: Number(sourceRow.total || 0),
      mirrorTotal: Number(mirror[0]?.total || 0),
      sourceAmountCents: Math.round(Number(sourceRow.amount || 0)),
      mirrorAmountCents: Number(mirror[0]?.amount || 0),
      totalDiff,
      amountDiff,
      dimensionDiff,
      quality,
    };
  }

  async today(q: { date?: string; communityIds?: number[] }, user: AuthUser, access?: ResolvedAccess) {
    const asOf = await this.assertReady(Number(user.tenantId));
    const date = q.date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const communities = await this.misFees.collectionCommunities(undefined, user, access, q.communityIds);
    const offices = [...new Set(communities.flatMap((community) => community.offices))];
    const params: unknown[] = [...offices];
    const placeholders = offices.map((_, index) => `$${index + 1}`).join(',');
    params.push(date);
    const dateParam = `$${params.length}`;
    const summary = (await this.dataSource.query(
      `SELECT COUNT(*)::int AS "paidCount",COALESCE(SUM(amount_cents),0)::bigint AS "paidCents",
              COUNT(DISTINCT office_code||':'||s_id)::int AS "paidHouses"
         FROM mis_mirror_bill
        WHERE office_code IN (${placeholders}) AND paid_date=${dateParam} AND refund_date IS NULL AND amount_cents>0`,
      params,
    ))[0] || {};
    const refund = (await this.dataSource.query(
      `SELECT COALESCE(SUM(amount_cents),0)::bigint AS "refundedCents" FROM mis_mirror_bill
        WHERE office_code IN (${placeholders}) AND refund_date=${dateParam} AND amount_cents>0`,
      params,
    ))[0] || {};
    const byFee: any[] = await this.dataSource.query(
      `SELECT ${this.categorySql} AS "feeCode",COUNT(*)::int AS "billCount",
              COUNT(DISTINCT office_code||':'||s_id)::int AS "houseCount",COALESCE(SUM(amount_cents),0)::bigint AS "paidCents"
         FROM mis_mirror_bill
        WHERE office_code IN (${placeholders}) AND paid_date=${dateParam} AND refund_date IS NULL AND amount_cents>0
        GROUP BY ${this.categorySql} ORDER BY "paidCents" DESC`,
      params,
    );
    const byChannel: any[] = await this.dataSource.query(
      `SELECT COALESCE(NULLIF(payment_method,''),'未记录') AS channel,COUNT(*)::int AS "billCount",
              COUNT(DISTINCT office_code||':'||s_id)::int AS "houseCount",COALESCE(SUM(amount_cents),0)::bigint AS "paidCents"
         FROM mis_mirror_bill
        WHERE office_code IN (${placeholders}) AND paid_date=${dateParam} AND refund_date IS NULL AND amount_cents>0
        GROUP BY channel ORDER BY "paidCents" DESC`,
      params,
    );
    return { source: 'mirror', dataAsOf: asOf, paidCents: Number(summary.paidCents || 0), paidCount: Number(summary.paidCount || 0), refundedCents: Number(refund.refundedCents || 0), paidHouses: Number(summary.paidHouses || 0), byFee: byFee.map((row) => ({ feeCode: String(row.feeCode || 'other'), feeName: misFeeCategoryLabel(row.feeCode), paidCents: Number(row.paidCents || 0), billCount: Number(row.billCount || 0), houseCount: Number(row.houseCount || 0) })), byChannel: byChannel.map((row) => ({ channel: row.channel, paidCents: Number(row.paidCents || 0), billCount: Number(row.billCount || 0), houseCount: Number(row.houseCount || 0) })) };
  }

  async todayDetails(q: { date?: string; category?: string; page?: number; pageSize?: number; communityIds?: number[] }, user: AuthUser, access?: ResolvedAccess) {
    const asOf = await this.assertReady(Number(user.tenantId));
    const date = q.date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00+08:00`))) throw new BadRequestException('日期不合法');
    if (q.category !== undefined && !['property', 'berth', 'parking', 'other'].includes(q.category)) throw new BadRequestException('分类不合法');
    const page = q.page ?? 1, pageSize = q.pageSize ?? 20;
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page 须为正整数');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new BadRequestException('pageSize 须为1-50的整数');
    const communities = await this.misFees.collectionCommunities(undefined, user, access, q.communityIds);
    const offices = [...new Set(communities.flatMap((community) => community.offices))];
    if (!offices.length) return { total: 0, groupCount: 0, page, pageSize, rows: [], source: 'mirror', dataAsOf: asOf };
    const params: unknown[] = [...offices, date];
    const officePlaceholders = offices.map((_, index) => `$${index + 1}`).join(',');
    const dateParam = `$${params.length}`;
    const categoryFilter = q.category ? `AND (${this.categorySql}) = $${params.push(q.category)}` : '';
    const where = `office_code IN (${officePlaceholders}) AND paid_date=${dateParam} AND refund_date IS NULL AND amount_cents>0 ${categoryFilter}`;
    const totalRows: any[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "groupCount",COALESCE(SUM(g.bill_count),0)::int AS total
         FROM (SELECT COUNT(*)::int AS bill_count FROM mis_mirror_bill WHERE ${where} GROUP BY office_code,s_id,zh_id) g`,
      params,
    );
    const rows: any[] = await this.dataSource.query(
      `WITH grouped AS (
         SELECT office_code,s_id,zh_id,address,owner_name,MAX(paid_date) AS paid_date,
                COALESCE(MAX(payment_method),'未记录') AS channel,SUM(amount_cents)::bigint AS amount_cents,
                COUNT(*)::int AS bill_count,MAX(source_updated_at) AS recorded_at
           FROM mis_mirror_bill WHERE ${where}
          GROUP BY office_code,s_id,zh_id,address,owner_name
       ) SELECT * FROM grouped ORDER BY recorded_at DESC,zh_id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    // PostgreSQL 的 date/timestamptz 在 Node 里可能按本地时区构造 Date，直接 toISOString 会偏一天/8 小时。
    const cstDay = (value: any) => {
      if (!value) return null;
      if (typeof value === 'string') return value.slice(0, 10);
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    };
    const cstIso = (value: any) => {
      if (!value) return null;
      const time = new Date(value).getTime();
      return Number.isNaN(time) ? null : new Date(time + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+08:00');
    };
    return {
      total: Number(totalRows[0]?.total || 0), groupCount: Number(totalRows[0]?.groupCount || 0), page, pageSize, source: 'mirror', dataAsOf: asOf,
      rows: rows.map((row) => ({
        recordedAt: cstIso(row.recorded_at),
        paidDate: cstDay(row.paid_date) ?? date,
        address: String(row.address || ''), ownerName: String(row.owner_name || ''),
        channel: String(row.channel || '未记录'), amountCents: Number(row.amount_cents || 0), billCount: Number(row.bill_count || 0),
      })),
    };
  }

  async screenSummary(q: { year?: number; communityIds?: number[]; granularity?: 'day' | 'month' }, user: AuthUser, access?: ResolvedAccess) {
    const dataAsOf = await this.assertReady(Number(user.tenantId));
    const now = new Date();
    const cst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (type: string) => Number(cst.find((part) => part.type === type)?.value || 0);
    const year = q.year ?? get('year');
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequestException('年份不合法');
    const communities = await this.misFees.residentialScope({ communityIds: q.communityIds } as any, user, access);
    const ids = communities.map((community) => community.id), offices = communities.flatMap((community) => community.offices);
    const placeholders = offices.map((_, index) => `$${index + 1}`).join(',');
    const startParam = `$${offices.length + 1}`, endParam = `$${offices.length + 2}`;
    const rows: any[] = await this.dataSource.query(
      `SELECT office_code AS "officeCode",paid_date::text AS day,${this.categorySql} AS "feeCode",SUM(amount_cents)::bigint AS amount,COUNT(*)::int AS "billCount",COUNT(DISTINCT s_id)::int AS "houseCount"
         FROM mis_mirror_bill
        WHERE office_code IN (${placeholders}) AND paid_date>=${startParam} AND paid_date<${endParam} AND refund_date IS NULL AND amount_cents>0
        GROUP BY office_code,paid_date,${this.categorySql} ORDER BY paid_date`,
      [...offices, `${year}-01-01`, `${year + 1}-01-01`],
    );
    // 参数顺序固定为 offices..., yearStart, yearEnd；占位符从 offices.length+1 开始。
    const dailyRows = rows.map((row) => ({ officeCode: String(row.officeCode), day: String(row.day).slice(0, 10), feeCode: String(row.feeCode || 'property'), paidCents: Number(row.amount || 0), billCount: Number(row.billCount || 0), houseCount: Number(row.houseCount || 0) }));
    const targets = await loadCollectionTargets(this.dataSource, Number(user.tenantId), ids, year);
    const arrearsResult: any = await this.residential({ view: 'amount-brackets', communityIds: q.communityIds } as any, user, access);
    const recent: any = await this.recentPayments({ pageSize: 10, communityIds: q.communityIds }, user, access);
    return { source: 'mirror', dataAsOf, queriedAt: now.toISOString(), ...buildScreenSummary({ year, communities, targets, dailyRows, arrears: { totalCents: Number(arrearsResult.total?.amountCents || 0), houseCount: Number(arrearsResult.total?.count || 0), buckets: (arrearsResult.buckets || []).map((row: any) => ({ key: String(row.key), count: Number(row.count || 0), amountCents: Number(row.amountCents || 0) })) }, recentPayments: recent.rows || [], granularity: q.granularity, now }) };
  }

  async recentPayments(q: { date?: string; page?: number; pageSize?: number; communityId?: number; communityIds?: number[] }, user: AuthUser, access?: ResolvedAccess) {
    const asOf = await this.assertReady(Number(user.tenantId));
    const date = q.date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 10;
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page 须为正整数');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new BadRequestException('pageSize 须为1-50的整数');
    const communities = await this.misFees.collectionCommunities(q.communityId, user, access, q.communityIds);
    const offices = [...new Set(communities.flatMap((community) => community.offices))];
    if (!offices.length) return { source: 'mirror', dataAsOf: asOf, total: 0, totalBills: 0, totalHouses: 0, page, pageSize, rows: [] };
    const params: unknown[] = [...offices, date];
    const officeParams = offices.map((_, index) => `$${index + 1}`).join(',');
    const dateParam = `$${params.length}`;
    const totals: any[] = await this.dataSource.query(
      `WITH grouped AS (
         SELECT office_code,s_id,zh_id,address,owner_name,SUM(amount_cents)::bigint AS amount,COUNT(*)::int AS bills,
                MAX(payment_method) AS channel,MAX(source_updated_at) AS recorded_at
           FROM mis_mirror_bill
          WHERE office_code IN (${officeParams}) AND paid_date=${dateParam} AND refund_date IS NULL AND amount_cents>0
          GROUP BY office_code,s_id,zh_id,address,owner_name
       )
       SELECT COUNT(*)::int AS total,COALESCE(SUM(bills),0)::int AS "totalBills",COUNT(*)::int AS "totalHouses" FROM grouped`,
      params,
    );
    const rows: any[] = await this.dataSource.query(
      `WITH grouped AS (
         SELECT office_code,s_id,zh_id,address,owner_name,SUM(amount_cents)::bigint AS amount,COUNT(*)::int AS bills,
                MAX(payment_method) AS channel,MAX(source_updated_at) AS recorded_at
           FROM mis_mirror_bill
          WHERE office_code IN (${officeParams}) AND paid_date=${dateParam} AND refund_date IS NULL AND amount_cents>0
          GROUP BY office_code,s_id,zh_id,address,owner_name
       ) SELECT * FROM grouped ORDER BY recorded_at DESC,zh_id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return { source: 'mirror', dataAsOf: asOf, total: Number(totals[0]?.total || 0), totalBills: Number(totals[0]?.totalBills || 0), totalHouses: Number(totals[0]?.totalHouses || 0), page, pageSize, rows: rows.map((row) => ({ paidAt: date, paidDate: date, paidAtPrecision: 'date', address: row.address, ownerName: row.owner_name, amountCents: Number(row.amount || 0), channel: row.channel || '未记录', billCount: Number(row.bills || 0), recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null, recordedAtPrecision: 'minute', communityId: communities.find((community) => community.offices.includes(row.office_code))?.id, communityName: communities.find((community) => community.offices.includes(row.office_code))?.name })) };
  }
}
