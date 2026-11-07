import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { TenantConfig } from '../../entities';
import { MisFeesService } from './mis-fees.service';

type MirrorMode = 'mis' | 'mirror';
type MirrorCommunity = { id: number; name: string; offices: string[] };

const DATA_SOURCE_KEY = 'data_source_mode';
const BATCH_SIZE = 500;
const MAX_BATCHES_PER_TICK = 4;
const MIS_TIMEOUT = 5_000;

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
      return { skipped: null, rows };
    } catch (error) {
      await this.recordSyncError(tenantId, 'bill', error).catch(() => undefined);
      await this.dataSource.query(
        `INSERT INTO system_logs(tenant_id,category,level,source,action,success,message,detail,created_at,updated_at)
         VALUES($1,'alert','warning','mis-mirror','mis_mirror_sync',false,$2,$3::jsonb,now(),now())`,
        [tenantId, `MIS 镜像同步失败：${(error as Error).message}`.slice(0, 500), JSON.stringify({ error: String((error as Error).message).slice(0, 500) })],
      ).catch(() => undefined);
      this.logger.warn(`MIS 镜像增量同步失败：${(error as Error).message}`);
      return { skipped: 'error', rows };
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
    let lastId = Number(state.last_id ?? 0);
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const since = lastUpdated ? new Date(lastUpdated.getTime() - 5 * 60_000) : null;
      const rows = await this.readBillBatch(since, lastId);
      if (!rows.length) break;
      await this.upsertBills(rows);
      total += rows.length;
      const tail = rows[rows.length - 1];
      lastUpdated = tail.sourceUpdatedAt ? new Date(tail.sourceUpdatedAt) : lastUpdated;
      lastId = Number(tail.zjId);
      if (rows.length < BATCH_SIZE) break;
    }
    await this.dataSource.query(
      `UPDATE mis_sync_state
          SET last_updated_at=$2,last_id=$3,last_success_at=now(),last_attempt_at=now(),
              last_error=NULL,lag_rows=$4,synced_rows=COALESCE(synced_rows,0)+$5
        WHERE tenant_id=$1 AND source_table='bill'`,
      [tenantId, lastUpdated, lastId, total >= BATCH_SIZE ? BATCH_SIZE : 0, total],
    );
    return total;
  }

  private async readBillBatch(since: Date | null, lastId: number) {
    const params: Record<string, string | number> = { take: BATCH_SIZE, lastId };
    const watermark = since
      ? `AND (w.updatedate > CONVERT(datetime,@since,126) OR (w.updatedate = CONVERT(datetime,@since,126) AND w.ZJ_ID > @lastId))`
      : '';
    if (since) params.since = this.misDateTime(since);
    const sql = `SELECT TOP (@take) w.ZJ_ID AS zjId, l.管理处 AS officeCode, l.L_ID AS lId,
        s.S_ID AS sId, z.ZH_ID AS zhId, z.姓名 AS ownerName, s.室 AS roomNo,
        ISNULL(l.地址1,N'')+ISNULL(l.字1,N'')+ISNULL(l.地址2,N'')+ISNULL(l.字2,N'')+
        ISNULL(l.地址3,N'')+ISNULL(l.字3,N'')+ISNULL(l.地址4,N'')+ISNULL(l.字4,N'')+
        ISNULL(s.室,N'')+ISNULL(s.字,N'') AS address,
        w.ZJ_LX AS feeCode, f.XM AS feeName, w.ZJ_CNY AS period,
        CAST(ROUND(w.ZJ_JE * 100, 0) AS bigint) AS amountCents,
        CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidDate,
        CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundDate,
        COALESCE(NULLIF(w.收款方式,N''),m.收款方式) AS paymentMethod,
        w.收款人 AS cashier,
        CONVERT(varchar(19),w.updatedate,126) AS sourceUpdatedAt
      FROM dbo.WYZJ w
      INNER JOIN dbo.业主表 z ON z.ZH_ID=w.ZH_ID
      INNER JOIN dbo.室表 s ON s.S_ID=z.S_ID
      INNER JOIN dbo.楼表 l ON l.L_ID=s.L_ID
      LEFT JOIN dbo.SETUPSFXM f ON f.DH=w.ZJ_LX
      LEFT JOIN dbo.收款方式列表 m ON m.id=w.收款方式ID
      WHERE ${since ? watermark : 'w.ZJ_ID > @lastId'}
        AND ISNULL(w.SC,N'0')=N'0'
      ORDER BY w.updatedate ASC,w.ZJ_ID ASC`;
    const result = await this.misFees.mirrorRead(sql, params, MIS_TIMEOUT);
    return (result?.recordsets?.[0] ?? []) as any[];
  }

  private async upsertBills(rows: any[]) {
    if (!rows.length) return;
    const fields = ['zjId', 'officeCode', 'lId', 'sId', 'zhId', 'ownerName', 'roomNo', 'address', 'feeCode', 'feeName', 'period', 'amountCents', 'paidDate', 'refundDate', 'paymentMethod', 'cashier', 'sourceUpdatedAt'];
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
      `INSERT INTO mis_mirror_bill(zj_id,office_code,l_id,s_id,zh_id,owner_name,room_no,address,fee_code,fee_name,period,amount_cents,paid_date,refund_date,payment_method,cashier,source_updated_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (zj_id) DO UPDATE SET
         office_code=EXCLUDED.office_code,l_id=EXCLUDED.l_id,s_id=EXCLUDED.s_id,zh_id=EXCLUDED.zh_id,
         owner_name=EXCLUDED.owner_name,room_no=EXCLUDED.room_no,address=EXCLUDED.address,
         fee_code=EXCLUDED.fee_code,fee_name=EXCLUDED.fee_name,period=EXCLUDED.period,
         amount_cents=EXCLUDED.amount_cents,paid_date=EXCLUDED.paid_date,refund_date=EXCLUDED.refund_date,
         payment_method=EXCLUDED.payment_method,cashier=EXCLUDED.cashier,
         source_updated_at=EXCLUDED.source_updated_at,synced_at=now()`,
      values,
    );
  }

  private async syncSmallDimensions() {
    const [fees, methods, offices] = await Promise.all([
      this.misFees.mirrorRead('SELECT DH AS feeCode,XM AS feeName FROM dbo.SETUPSFXM', {}, MIS_TIMEOUT),
      this.misFees.mirrorRead('SELECT id AS methodId,收款方式 AS methodName FROM dbo.收款方式列表', {}, MIS_TIMEOUT),
      this.misFees.mirrorRead('SELECT DISTINCT 管理处 AS officeCode FROM dbo.楼表', {}, MIS_TIMEOUT),
    ]);
    const feeRows = (fees?.recordsets?.[0] ?? []) as any[];
    const methodRows = (methods?.recordsets?.[0] ?? []) as any[];
    const officeRows = (offices?.recordsets?.[0] ?? []) as any[];
    for (const row of feeRows) {
      await this.dataSource.query(
        `INSERT INTO mis_mirror_fee_item(fee_code,fee_name,synced_at) VALUES($1,$2,now())
         ON CONFLICT (fee_code) DO UPDATE SET fee_name=EXCLUDED.fee_name,synced_at=now()`,
        [String(row.feeCode), String(row.feeName ?? '')],
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
   * 手工全量重灌：先维度后账单，按 ZJ_ID keyset 分批 500。
   * 只允许管理员触发；不在定时任务里调用。
   */
  async reloadAll(tenantId: number) {
    const lock = await this.dataSource.query(`SELECT pg_try_advisory_lock(hashtext('mis-mirror-sync')) AS ok`);
    if (!lock?.[0]?.ok) throw new BadRequestException('镜像同步正在运行，请稍后再试');
    try {
      const buildings = (await this.misFees.mirrorRead('SELECT L_ID AS lId,管理处 AS officeCode,地址1 AS road,地址2 AS lane,地址3 AS buildingNo FROM dbo.楼表', {}, MIS_TIMEOUT)).recordsets?.[0] ?? [];
      const rooms = (await this.misFees.mirrorRead('SELECT S_ID AS sId,L_ID AS lId,室 AS roomNo,房屋性质 AS nature,建筑面积 AS areaSqm FROM dbo.室表', {}, MIS_TIMEOUT)).recordsets?.[0] ?? [];
      const owners = (await this.misFees.mirrorRead('SELECT ZH_ID AS zhId,S_ID AS sId,姓名 AS name,移动电话 AS mobile,固定电话 AS phone2,updatedate AS sourceUpdatedAt FROM dbo.业主表', {}, MIS_TIMEOUT)).recordsets?.[0] ?? [];
      await this.dataSource.transaction(async (manager) => {
        await manager.query('DELETE FROM mis_mirror_building');
        await manager.query('DELETE FROM mis_mirror_room');
        await manager.query('DELETE FROM mis_mirror_owner');
        for (const row of buildings as any[]) await manager.query(
          `INSERT INTO mis_mirror_building(l_id,office_code,road,lane,building_no,synced_at) VALUES($1,$2,$3,$4,$5,now())`,
          [row.lId, row.officeCode, row.road ?? null, row.lane ?? null, row.buildingNo ?? null],
        );
        for (const row of rooms as any[]) await manager.query(
          `INSERT INTO mis_mirror_room(s_id,l_id,room_no,nature,area_sqm,synced_at) VALUES($1,$2,$3,$4,$5,now())`,
          [row.sId, row.lId ?? null, row.roomNo ?? '', row.nature ?? null, row.areaSqm ?? null],
        );
        for (const row of owners as any[]) await manager.query(
          `INSERT INTO mis_mirror_owner(zh_id,s_id,name,mobile,phone2,source_updated_at,synced_at) VALUES($1,$2,$3,$4,$5,$6,now())`,
          [row.zhId, row.sId ?? null, row.name ?? null, row.mobile ?? null, row.phone2 ?? null, row.sourceUpdatedAt ?? null],
        );
      });
      await this.syncSmallDimensions();
      await this.dataSource.query(
        `INSERT INTO mis_sync_state(tenant_id,source_table,initialized_at,last_attempt_at)
         VALUES($1,'bill',now(),now())
         ON CONFLICT (tenant_id,source_table) DO UPDATE SET initialized_at=now(),last_attempt_at=now(),last_error=NULL`,
        [tenantId],
      );
      let lastId = 0;
      let total = 0;
      for (;;) {
        const batch = (await this.misFees.mirrorRead(
          `SELECT TOP (@take) w.ZJ_ID AS zjId, l.管理处 AS officeCode, l.L_ID AS lId, s.S_ID AS sId, z.ZH_ID AS zhId,
             z.姓名 AS ownerName, s.室 AS roomNo,
             ISNULL(l.地址1,N'')+ISNULL(l.字1,N'')+ISNULL(l.地址2,N'')+ISNULL(l.字2,N'')+ISNULL(l.地址3,N'')+ISNULL(l.字3,N'')+ISNULL(l.地址4,N'')+ISNULL(l.字4,N'')+ISNULL(s.室,N'')+ISNULL(s.字,N'') AS address,
             w.ZJ_LX AS feeCode, f.XM AS feeName, w.ZJ_CNY AS period, CAST(ROUND(w.ZJ_JE*100,0) AS bigint) AS amountCents,
             CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidDate, CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundDate,
             COALESCE(NULLIF(w.收款方式,N''),m.收款方式) AS paymentMethod, w.收款人 AS cashier,
             CONVERT(varchar(19),w.updatedate,126) AS sourceUpdatedAt           FROM dbo.WYZJ w
           INNER JOIN dbo.业主表 z ON z.ZH_ID=w.ZH_ID
           INNER JOIN dbo.室表 s ON s.S_ID=z.S_ID
           INNER JOIN dbo.楼表 l ON l.L_ID=s.L_ID
           LEFT JOIN dbo.SETUPSFXM f ON f.DH=w.ZJ_LX
           LEFT JOIN dbo.收款方式列表 m ON m.id=w.收款方式ID
           WHERE w.ZJ_ID > @lastId AND ISNULL(w.SC,N'0')=N'0'
           ORDER BY w.ZJ_ID`,
          { take: BATCH_SIZE, lastId }, MIS_TIMEOUT,
        )).recordsets?.[0] ?? [];
        await this.upsertBills(batch as any[]);
        total += batch.length;
        if (!batch.length) break;
        lastId = Number((batch as any[])[batch.length - 1].zjId);
        if (batch.length < BATCH_SIZE) break;
      }
      const last = await this.dataSource.query(
        `SELECT MAX(source_updated_at) AS lastUpdated,MAX(zj_id) AS lastId FROM mis_mirror_bill`,
      );
      await this.dataSource.query(
        `UPDATE mis_sync_state SET last_updated_at=$2,last_id=$3,last_success_at=now(),last_error=NULL,lag_rows=0,synced_rows=$4
          WHERE tenant_id=$1 AND source_table='bill'`,
        [tenantId, last[0]?.lastupdated ?? null, last[0]?.lastid ?? null, total],
      );
      return { rows: total };
    } finally {
      await this.dataSource.query(`SELECT pg_advisory_unlock(hashtext('mis-mirror-sync'))`).catch(() => undefined);
    }
  }

  private async recordSyncError(tenantId: number, source: string, error: unknown) {
    await this.dataSource.query(
      `INSERT INTO mis_sync_state(tenant_id,source_table,last_attempt_at,last_error)
       VALUES($1,$2,now(),$3)
       ON CONFLICT (tenant_id,source_table) DO UPDATE SET last_attempt_at=now(),last_error=EXCLUDED.last_error`,
      [tenantId, source, String((error as Error)?.message ?? error).slice(0, 500)],
    );
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

  private categorySql = `(CASE WHEN fee_name LIKE '%泊位%' OR fee_name LIKE '%车位%' OR fee_name LIKE '%停车%' THEN 'berth' WHEN fee_name LIKE '%物业%' OR (fee_name LIKE '%管理费%' AND fee_name NOT LIKE '%停车%') THEN 'property' ELSE 'other' END)`;

  async residential(q: any, user: AuthUser, access?: ResolvedAccess) {
    if (!['dashboard', 'households', 'amount-brackets', 'communities'].includes(q.view || 'dashboard')) {
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
        rows.push({ id: community.id, name: community.name, receivableCents: Number(sum.receivableCents || 0), paidCents: Number(sum.paidCents || 0), unpaidCents: Number(sum.unpaidCents || 0), unpaidHouses: Number(sum.unpaidHouses || 0), rate: Number(sum.receivableCents) > 0 ? Math.round((Number(sum.paidCents) / Number(sum.receivableCents)) * 1000) / 10 : null });
      }
      rows.sort((a, b) => b.unpaidCents - a.unpaidCents);
      return { ...meta, rows };
    }
    const built = await this.buildWhere(q, offices);
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
                COUNT(DISTINCT CASE WHEN paid_date IS NULL AND refund_date IS NULL AND amount_cents>0 THEN office_code||':'||s_id END)::int AS "unpaidHouses"
           FROM mis_mirror_bill WHERE ${built.where} GROUP BY fee_code,fee_name,${this.categorySql} ORDER BY "unpaidCents" DESC`,
        built.params,
      );
      return { ...meta, summary: { receivableCents: Number(summaryRows[0]?.receivableCents || 0), paidCents: Number(summaryRows[0]?.paidCents || 0), unpaidCents: Number(summaryRows[0]?.unpaidCents || 0), total: Number(summaryRows[0]?.total || 0), unpaidHouses: Number(summaryRows[0]?.unpaidHouses || 0), adjustmentCount: Number(summaryRows[0]?.adjustmentCount || 0) }, byFee: byFee.map((row) => ({ receivableCents: Number(row.receivableCents || 0), paidCents: Number(row.paidCents || 0), unpaidCents: Number(row.unpaidCents || 0), feeCode: row.feeCode, feeName: row.feeName || '未命名费项', category: row.category, unpaidHouses: Number(row.unpaidHouses || 0) })) };
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
    for (const tenant of tenants) rows += (await this.syncTick(Number(tenant.id)))?.rows || 0;
    return { rows, tenants: tenants.length };
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
    const mirror: any[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total,COALESCE(SUM(amount_cents),0)::bigint AS amount FROM mis_mirror_bill`,
    );
    const totalDiff = Number(mirror[0]?.total || 0) - Number(sourceRow.total || 0);
    const amountDiff = Number(mirror[0]?.amount || 0) - Math.round(Number(sourceRow.amount || 0));
    const ok = totalDiff === 0 && amountDiff === 0;
    await this.dataSource.query(
      `INSERT INTO system_logs(tenant_id,category,level,source,action,success,message,detail,created_at,updated_at)
       VALUES($1,'alert',$2,'mis-mirror',$3,$4,$5,$6::jsonb,now(),now())`,
      [tenantId, ok ? 'info' : 'warning', 'mis_mirror_reconcile', ok,
        ok ? 'MIS 镜像对账一致' : `MIS 镜像不一致：记录差 ${totalDiff}、金额差 ${amountDiff} 分`,
        JSON.stringify({ sourceTotal: Number(sourceRow.total || 0), mirrorTotal: Number(mirror[0]?.total || 0), sourceAmountCents: Math.round(Number(sourceRow.amount || 0)), mirrorAmountCents: Number(mirror[0]?.amount || 0), totalDiff, amountDiff })],
    ).catch(() => undefined);
    return { ok, sourceTotal: Number(sourceRow.total || 0), mirrorTotal: Number(mirror[0]?.total || 0), sourceAmountCents: Math.round(Number(sourceRow.amount || 0)), mirrorAmountCents: Number(mirror[0]?.amount || 0), totalDiff, amountDiff };
  }

  async today(q: { date?: string }, user: AuthUser, access?: ResolvedAccess) {
    const asOf = await this.assertReady(Number(user.tenantId));
    const date = q.date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const communities = await this.misFees.collectionCommunities(undefined, user, access);
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
      `SELECT ${this.categorySql} AS "feeName",COUNT(*)::int AS "billCount",
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
    return { source: 'mirror', dataAsOf: asOf, paidCents: Number(summary.paidCents || 0), paidCount: Number(summary.paidCount || 0), refundedCents: Number(refund.refundedCents || 0), paidHouses: Number(summary.paidHouses || 0), byFee: byFee.map((row) => ({ feeName: row.feeName, paidCents: Number(row.paidCents || 0), billCount: Number(row.billCount || 0), houseCount: Number(row.houseCount || 0) })), byChannel: byChannel.map((row) => ({ channel: row.channel, paidCents: Number(row.paidCents || 0), billCount: Number(row.billCount || 0), houseCount: Number(row.houseCount || 0) })) };
  }

  async recentPayments(q: { date?: string; page?: number; pageSize?: number; communityId?: number }, user: AuthUser, access?: ResolvedAccess) {
    const asOf = await this.assertReady(Number(user.tenantId));
    const date = q.date ?? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 10;
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page 须为正整数');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new BadRequestException('pageSize 须为1-50的整数');
    const communities = await this.misFees.collectionCommunities(q.communityId, user, access);
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
