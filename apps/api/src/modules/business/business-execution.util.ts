/**
 * 收费后的「执行层」纯逻辑：不碰数据库、不发请求，便于单测。
 * 状态记在 business_transactions.external_sync_status（varchar 20）与 snapshot.execution 上，不新增表。
 */

/** 外部同步状态（写入 external_sync_status） */
export type ExternalSyncStatus =
  | 'mocked' //   旧数据/未接入的业务（门禁卡等，P2 再接）
  | 'queued' //   已排队，等待执行
  | 'running' //  执行中（已被某个进程原子领取）
  | 'retry' //    临时失败，等待自动重试
  | 'synced' //   已生效并回读确认
  | 'dry_run' //  演练：只读核对并记下「将要写什么」，未写入
  | 'manual' //   需要人工处理（数据对不上，不自动重试）
  | 'failed'; //  多次重试仍失败

/** BUSINESS_DELIYUN_SYNC：off=不自动同步（旧行为）；dry-run=只读演练（默认）；on=真实写入 */
export type SyncMode = 'off' | 'dry-run' | 'on';

export function parseSyncMode(raw: string | undefined | null): SyncMode {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'on' || v === 'true') return 'on';
  if (v === 'off' || v === 'false') return 'off';
  return 'dry-run';
}

export const MAX_ATTEMPTS = 3;
/** 第 n 次失败后多久重试（分钟） */
const BACKOFF_MIN = [1, 5, 15];
export function nextRetryAt(attempts: number, now = new Date()): Date {
  const min = BACKOFF_MIN[Math.min(Math.max(attempts, 1), BACKOFF_MIN.length) - 1];
  return new Date(now.getTime() + min * 60_000);
}

/** 德立云车辆（只取决策要用的字段） */
export interface DeliyunVehicleLite {
  id: string;
  plate: string;
  endDate: string | null;
  cardPoolId: string | null;
}

export type RenewalPlan =
  | { action: 'noop'; vehicleId: string; endDate: string; reason: string }
  | { action: 'renew'; vehicleId: string; previousEndDate: string; endDate: string }
  | { action: 'manual'; reason: string };

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * 决定德立云要不要续、怎么续。原则：只把到期日往后延到本次收费的到期日；
 * 任何对不上的情况都转人工，不猜、不回退、不覆盖。
 */
export function planDeliyunRenewal(input: { plate: string; targetEndDate: string | null; rows: DeliyunVehicleLite[] }): RenewalPlan {
  const { plate, targetEndDate, rows } = input;
  if (!isDate(targetEndDate)) return { action: 'manual', reason: '本次收费没有到期日，无法同步德立云' };
  if (!rows.length) return { action: 'manual', reason: `德立云未登记车牌 ${plate}，请先在德立云登记该车后点「重试」` };
  if (rows.length > 1) return { action: 'manual', reason: `德立云有 ${rows.length} 条 ${plate} 的记录，需人工确认是哪一条` };
  const v = rows[0];
  if (v.cardPoolId) return { action: 'manual', reason: '该车属于车位池，有效期跟随关联车位，请在德立云按车位处理' };
  if (!isDate(v.endDate)) return { action: 'manual', reason: '德立云该车没有到期日，需人工核对后处理' };
  if (v.endDate === targetEndDate) return { action: 'noop', vehicleId: v.id, endDate: v.endDate, reason: '德立云到期日已是本次目标' };
  if (v.endDate > targetEndDate) {
    return { action: 'manual', reason: `德立云到期日 ${v.endDate} 已晚于本次收费到期日 ${targetEndDate}，不自动回退，请人工核对` };
  }
  return { action: 'renew', vehicleId: v.id, previousEndDate: v.endDate, endDate: targetEndDate };
}

/**
 * 失败分类：参数/数据类错误（HTTP 400 语义）重试也没用 → 转人工；
 * 服务暂不可用/网络类 → 自动重试，超过次数 → failed。
 */
export function classifyFailure(error: unknown, attempts: number): { status: ExternalSyncStatus; message: string } {
  const message = (error instanceof Error ? error.message : String(error || '执行失败')).slice(0, 300);
  const httpStatus = typeof (error as { getStatus?: () => number })?.getStatus === 'function'
    ? (error as { getStatus: () => number }).getStatus()
    : undefined;
  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 409) return { status: 'manual', message };
  if (/尚未启用|尚未配置/.test(message)) return { status: 'manual', message };
  return { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', message };
}

/** 可以人工点「重试」的状态 */
export const RETRYABLE_BY_HAND: ExternalSyncStatus[] = ['manual', 'failed', 'dry_run', 'retry'];
