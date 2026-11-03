/**
 * 停车单车牌写操作的前端执行层：提交 → 轮询 → 分类结果。
 *
 * 旧库操作（parking1/parking2）走通用队列：POST /parking/operations 返回 pending，
 * 再轮询 GET /parking/operations/:id 直到 completed/failed；现场网关（data-sync-assistant）
 * 认领任务、跑存储过程、读回校验后回报。德立云（人防）操作走各自的内联端点，直接回 completed。
 *
 * 规格见 docs/parking-per-plate-ops-spec.md。
 */
import { accessCardIssuance } from '@pms/api-client';
import type { ParkingOperation, ParkingOperationKind, ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';
import { dayjs } from '@/lib/format';
import { field, rawBits } from '@/lib/parking-fields';

/** 旧库记录主键 P_id（= sourceRecordId） */
export function pidOf(f: ParkingQueryRow['fields']): string {
  const k = Object.keys(f).find((key) => /^pid$/i.test(key.replace(/[\s_\-]/g, '')));
  return k && f[k] != null ? String(f[k]) : '';
}
/** 库短名 */
export function dbShort(db: string): string {
  return db === 'parking1' ? '一期库' : db === 'parking2' ? '二期库' : db === 'deliyun' ? '德立云' : db;
}
/** 规整成 YYYY-MM-DD；非日期返回空串 */
export function ymd(v: string | null | undefined): string {
  return v && dayjs(v).isValid() ? dayjs(v).format('YYYY-MM-DD') : '';
}
/** 旧库各目标行透传的车辆字段（改牌/类型等要保留原授权位、车位、备注，否则会被清掉） */
export function passthroughFields(r: ParkingQueryRow): Record<string, unknown> {
  return {
    identity: field(r.fields, 'identity') || '住户车',
    ownerRoom: field(r.fields, 'room', true),
    space: field(r.fields, 'space'),
    note: field(r.fields, 'note', true),
    effective: rawBits(r.fields, 'effective'),
    download: rawBits(r.fields, 'download'),
  };
}

/** 每次逻辑提交生成一个幂等键；多库扇出时按库加后缀，德立云副作用加 -deliyun */
export function createIdempotencyKey(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `pms-${Date.now().toString(36)}-${rand}`;
}

/** 续期到期日：从当前到期日（或今天）起加 N 个月，落到自然月末，YYYY-MM-DD */
export function renewalEndDate(currentEndDate: string | null | undefined, months: number): string {
  const base = currentEndDate && dayjs(currentEndDate).isValid() ? dayjs(currentEndDate) : dayjs();
  return base.add(months, 'month').endOf('month').format('YYYY-MM-DD');
}

/** 多库续期只在第一库记一次收款，其余记 0，避免费用报表重复计数 */
export function allocateRenewalAmounts(amountCents: number, count: number): number[] {
  if (count <= 0) return [];
  return [amountCents, ...Array(count - 1).fill(0)];
}

/** 车辆授权类型 → 费率档：亲情车免费，含「租」按租户，其余按业主 */
export function rateKeyOf(identity: string): 'owner' | 'tenant' {
  return identity.includes('租') ? 'tenant' : 'owner';
}

export type OpOutcome =
  | { kind: 'ok'; operation: ParkingOperation }
  | { kind: 'failed'; error: string; operation: ParkingOperation }
  | { kind: 'timeout'; operation: ParkingOperation };

/**
 * 提交一个旧库操作并轮询到终态。
 * 轮询上限 ~90 秒（112 次 × 800ms），超时保留任务、不重复提交。
 */
export async function submitAndPoll(
  data: {
    database: 'parking1' | 'parking2';
    kind: ParkingOperationKind;
    sourceRecordId?: string;
    pmsUserId?: number | null;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    expected?: Record<string, unknown>;
  },
  onTick?: (op: ParkingOperation) => void,
): Promise<OpOutcome> {
  let op = await accessCardIssuance.createParkingOperation(data);
  onTick?.(op);
  for (let i = 0; i < 112; i += 1) {
    if (op.status === 'completed') return { kind: 'ok', operation: op };
    if (op.status === 'failed') return { kind: 'failed', error: op.error || '现场执行失败', operation: op };
    if (op.status === 'cancelled') return { kind: 'failed', error: '任务已取消', operation: op };
    await delay(800);
    op = await accessCardIssuance.parkingOperation(op.id);
    onTick?.(op);
  }
  if (op.status === 'completed') return { kind: 'ok', operation: op };
  if (op.status === 'failed') return { kind: 'failed', error: op.error || '现场执行失败', operation: op };
  return { kind: 'timeout', operation: op };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
}

/**
 * 对一组旧库目标行（一期/二期）依次执行同一种操作：提交→轮询，任一失败/超时即停。
 * 多目标时幂等键按库加后缀；单目标用同一批次键。
 */
export async function runOnTargets(
  targets: ParkingQueryRow[],
  kind: ParkingOperationKind,
  buildPayload: (row: ParkingQueryRow, index: number) => Record<string, unknown>,
  opts?: { pmsUserId?: number | null; onLog?: (line: string) => void; batchKey?: string },
): Promise<{ ok: boolean; error?: string; timeout?: boolean }> {
  const batch = opts?.batchKey || createIdempotencyKey();
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    const db = t.database as 'parking1' | 'parking2';
    opts?.onLog?.(`正在处理 ${dbShort(db)}…`);
    const outcome = await submitAndPoll({
      database: db,
      kind,
      sourceRecordId: pidOf(t.fields) || undefined,
      pmsUserId: opts?.pmsUserId,
      idempotencyKey: targets.length > 1 ? `${batch}-${db}` : batch,
      payload: buildPayload(t, i),
    });
    if (outcome.kind === 'failed') { opts?.onLog?.(`✗ ${dbShort(db)} 失败`); return { ok: false, error: `${dbShort(db)}：${outcome.error}` }; }
    if (outcome.kind === 'timeout') { opts?.onLog?.(`… ${dbShort(db)} 超时，任务已保留`); return { ok: false, timeout: true, error: `${dbShort(db)} 现场网关响应超时，任务已保留，请稍后在办理记录查看，勿重复提交` }; }
    opts?.onLog?.(`✓ ${dbShort(db)} 完成`);
  }
  return { ok: true };
}
