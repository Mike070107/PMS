import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 工单撤回改造：完工提交批次 + 用料冲销 + 操作快照。
 *
 * 迁移只补结构和归属关系，**绝不重算或修改任何现有库存数量**。
 * 历史用料一律标 legacy_issue；待验收/已完成工单的用料归入一条兼容批次，
 * 好让这些老单也能走新的撤回退料流程。对不上的记录留给
 * `tools/work-order-material-audit.mjs` 出核对报告，人工处理，不在这里偷偷补账。
 */
export class WorkOrderCompletionBatchAndReversal1789088400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS work_order_completion_batches (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_by int NULL,
        updated_by int NULL,
        tenant_id int NOT NULL,
        work_order_id int NOT NULL,
        version_no int NOT NULL DEFAULT 1,
        status varchar(20) NOT NULL DEFAULT 'active',
        idempotency_key varchar(80) NULL,
        from_status varchar(24) NULL,
        submitted_by int NULL,
        submitted_at timestamptz NULL,
        reversed_by int NULL,
        reversed_at timestamptz NULL,
        reverse_reason varchar(500) NULL,
        rollback_log_id int NULL,
        snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_wo_completion_batch_order
         ON work_order_completion_batches (tenant_id, work_order_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_wo_completion_batch_status
         ON work_order_completion_batches (tenant_id, work_order_id, status)`,
    );
    // 同一工单同一版本号只能有一条，防止并发重复完工插出两条 active
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wo_completion_batch_version
         ON work_order_completion_batches (tenant_id, work_order_id, version_no)`,
    );
    // 幂等令牌：同一工单同一令牌只认第一次提交
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wo_completion_batch_idem
         ON work_order_completion_batches (tenant_id, work_order_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE work_order_materials
        ADD COLUMN IF NOT EXISTS completion_batch_id int NULL,
        ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS source_action varchar(20) NOT NULL DEFAULT 'completion',
        ADD COLUMN IF NOT EXISTS reversed_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS reversed_by int NULL,
        ADD COLUMN IF NOT EXISTS reverse_reason varchar(500) NULL,
        ADD COLUMN IF NOT EXISTS reversal_movement_id int NULL,
        ADD COLUMN IF NOT EXISTS issue_movement_id int NULL
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_wo_material_status
         ON work_order_materials (tenant_id, work_order_id, status)`,
    );
    // 一条用料最多退一次料：冲回流水 id 唯一
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_wo_material_reversal_movement
         ON work_order_materials (reversal_movement_id)
       WHERE reversal_movement_id IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE work_order_logs
        ADD COLUMN IF NOT EXISTS before_snapshot jsonb NULL,
        ADD COLUMN IF NOT EXISTS after_snapshot jsonb NULL,
        ADD COLUMN IF NOT EXISTS rolled_back_log_id int NULL,
        ADD COLUMN IF NOT EXISTS reverted_by_log_id int NULL,
        ADD COLUMN IF NOT EXISTS rollback_detail jsonb NULL
    `);

    await queryRunner.query(`
      ALTER TABLE reviews
        ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS reversed_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS reversed_by_log_id int NULL
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_review_status ON reviews (tenant_id, work_order_id, status)`,
    );

    await queryRunner.query(`
      ALTER TABLE stock_movements
        ADD COLUMN IF NOT EXISTS reversal_of_movement_id int NULL
    `);
    // 同一条出库流水最多被冲销一次 —— 重复撤回不可能退出第二份库存
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movement_reversal_of
         ON stock_movements (reversal_of_movement_id)
       WHERE reversal_of_movement_id IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE ai_assist_feedback
        ADD COLUMN IF NOT EXISTS completion_batch_id int NULL,
        ADD COLUMN IF NOT EXISTS source_reversed boolean NOT NULL DEFAULT false
    `);

    // ---- 历史数据兼容（只补归属，不动库存数量）----
    // 1) 批次机制之前的用料全部标 legacy_issue，和之后的正式完工扣料区分开。
    await queryRunner.query(
      `UPDATE work_order_materials SET source_action = 'legacy_issue' WHERE completion_batch_id IS NULL`,
    );

    // 2) 已经提交过完工的工单（待验收/已完成）建一条兼容批次，把它的用料挂进去，
    //    这些老单才能走新的「撤回完工 → 精确退料」流程。
    await queryRunner.query(`
      INSERT INTO work_order_completion_batches (
        tenant_id, work_order_id, version_no, status, from_status,
        submitted_by, submitted_at, snapshot, created_by, updated_by
      )
      SELECT wo.tenant_id,
             wo.id,
             1,
             'active',
             NULL,
             wo.updated_by,
             COALESCE(wo.completed_at, wo.updated_at),
             jsonb_build_object(
               'legacy', true,
               'faultLocation', wo.fault_location,
               'faultSymptom', wo.fault_symptom,
               'repairContent', wo.repair_content,
               'actionTags', wo.action_tags,
               'actionNote', wo.action_note,
               'resultAttachments', wo.result_attachments,
               'feeCents', wo.fee_cents,
               'materials', COALESCE(
                 (SELECT jsonb_agg(jsonb_build_object(
                           'materialId', m.material_id,
                           'warehouseId', m.warehouse_id,
                           'qty', m.qty
                         ))
                    FROM work_order_materials m
                   WHERE m.tenant_id = wo.tenant_id AND m.work_order_id = wo.id),
                 '[]'::jsonb)
             ),
             wo.updated_by,
             wo.updated_by
        FROM work_orders wo
       WHERE wo.status IN ('done_pending_review', 'completed')
         AND NOT EXISTS (
           SELECT 1 FROM work_order_completion_batches b
            WHERE b.tenant_id = wo.tenant_id AND b.work_order_id = wo.id
         )
    `);
    await queryRunner.query(`
      UPDATE work_order_materials m
         SET completion_batch_id = b.id
        FROM work_order_completion_batches b
       WHERE b.tenant_id = m.tenant_id
         AND b.work_order_id = m.work_order_id
         AND m.completion_batch_id IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ai_assist_feedback
         DROP COLUMN IF EXISTS completion_batch_id,
         DROP COLUMN IF EXISTS source_reversed`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS uq_stock_movement_reversal_of`);
    await queryRunner.query(
      `ALTER TABLE stock_movements DROP COLUMN IF EXISTS reversal_of_movement_id`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_review_status`);
    await queryRunner.query(
      `ALTER TABLE reviews
         DROP COLUMN IF EXISTS status,
         DROP COLUMN IF EXISTS reversed_at,
         DROP COLUMN IF EXISTS reversed_by_log_id`,
    );
    await queryRunner.query(
      `ALTER TABLE work_order_logs
         DROP COLUMN IF EXISTS before_snapshot,
         DROP COLUMN IF EXISTS after_snapshot,
         DROP COLUMN IF EXISTS rolled_back_log_id,
         DROP COLUMN IF EXISTS reverted_by_log_id,
         DROP COLUMN IF EXISTS rollback_detail`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS uq_wo_material_reversal_movement`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_wo_material_status`);
    await queryRunner.query(
      `ALTER TABLE work_order_materials
         DROP COLUMN IF EXISTS completion_batch_id,
         DROP COLUMN IF EXISTS status,
         DROP COLUMN IF EXISTS source_action,
         DROP COLUMN IF EXISTS reversed_at,
         DROP COLUMN IF EXISTS reversed_by,
         DROP COLUMN IF EXISTS reverse_reason,
         DROP COLUMN IF EXISTS reversal_movement_id,
         DROP COLUMN IF EXISTS issue_movement_id`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS work_order_completion_batches`);
  }
}
