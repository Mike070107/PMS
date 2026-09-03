import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';
import { WorkOrderStatus } from '../common/enums';

/** active=当前生效的一次完工提交；reversed=已被撤回冲销，只留档不参与统计 */
export type CompletionBatchStatus = 'active' | 'reversed';

/**
 * 一次「提交完工」的批次。
 *
 * 为什么必须有这张表：撤回完工要精确退回**这一次**扣的料，不能笼统按工单退。
 * 缺料领用、上一轮完工、本轮完工的用料混在 work_order_materials 里，
 * 没有批次就分不清哪几条是本次提交扣的（2026-09-03 撤回改造）。
 *
 * 每次重新完工都 insert 一条新版本（version_no 递增），旧版本置 reversed 永久保留，
 * 绝不 update 覆盖 —— 报表和库存对账都要能还原「扣料 → 退料 → 重新扣料」全过程。
 */
@Entity('work_order_completion_batches')
@Index(['tenantId', 'workOrderId'])
@Index(['tenantId', 'workOrderId', 'status'])
// 同一工单同一版本号只能有一条：并发重复完工插不出两条 active
@Index(['tenantId', 'workOrderId', 'versionNo'], { unique: true })
// 幂等令牌：同一工单同一令牌只认第一次提交
@Index(['tenantId', 'workOrderId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotency_key" IS NOT NULL',
})
export class WorkOrderCompletionBatch extends TenantEntity {
  @Column({ name: 'work_order_id', type: 'int' })
  workOrderId: number;

  /** 同一工单内自增，从 1 开始；重新完工 = 新版本 */
  @Column({ name: 'version_no', type: 'int', default: 1 })
  versionNo: number;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: CompletionBatchStatus;

  /**
   * 端上生成的提交令牌。同一令牌重复提交直接返回上次结果，
   * 不再扣第二次料（连点两下 / 弱网重试）。
   */
  @Column({ name: 'idempotency_key', type: 'varchar', length: 80, nullable: true })
  idempotencyKey: string | null;

  /** 完工前的真实状态（维修中 / 等待材料），撤回时按它恢复，不靠猜 */
  @Column({ name: 'from_status', type: 'varchar', length: 24, nullable: true })
  fromStatus: WorkOrderStatus | null;

  @Column({ name: 'submitted_by', type: 'int', nullable: true })
  submittedBy: number | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'reversed_by', type: 'int', nullable: true })
  reversedBy: number | null;

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;

  @Column({ name: 'reverse_reason', type: 'varchar', length: 500, nullable: true })
  reverseReason: string | null;

  /** 冲销它的那条 work_order_logs.id，轨迹里可以互相跳转 */
  @Column({ name: 'rollback_log_id', type: 'int', nullable: true })
  rollbackLogId: number | null;

  /**
   * 本次提交的完工内容快照：完工文字、照片、收费、材料清单。
   * 撤回后原样回填到完工表单当草稿，维修工不用重填一遍。
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  snapshot: {
    faultLocation?: string | null;
    faultSymptom?: string | null;
    repairContent?: string | null;
    actionTags?: string[];
    actionNote?: string | null;
    resultAttachments?: string[];
    feeCents?: number;
    /** 本次提交的材料原始行（含仓库/数量/单位/备注），撤回后作为可编辑草稿 */
    materials?: Array<{
      materialId?: number | null;
      warehouseId?: number | null;
      name?: string;
      qty: number;
      unit?: string;
      note?: string;
    }>;
  };
}
