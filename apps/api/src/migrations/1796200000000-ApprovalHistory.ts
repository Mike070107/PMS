import { MigrationInterface, QueryRunner } from 'typeorm';

export class ApprovalHistory1796200000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    for (const table of ['purchase_requests', 'maintenance_orders', 'stocktake_tasks']) {
      await q.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS approval_log jsonb NOT NULL DEFAULT '[]'::jsonb`);
    }
    // Only recover decisions with a real reviewer AND review timestamp. No updated_at guesses.
    await q.query(`UPDATE purchase_requests SET approval_log =
      CASE WHEN office_reviewer_id IS NOT NULL AND office_reviewed_at IS NOT NULL THEN jsonb_build_array(jsonb_build_object('userId', office_reviewer_id, 'at', office_reviewed_at, 'stage', 'office', 'result', '办公室通过')) ELSE '[]'::jsonb END ||
      CASE WHEN manager_id IS NOT NULL AND manager_at IS NOT NULL THEN jsonb_build_array(jsonb_build_object('userId', manager_id, 'at', manager_at, 'stage', 'manager', 'result', '经理通过')) ELSE '[]'::jsonb END ||
      CASE WHEN purchaser_id IS NOT NULL AND purchaser_at IS NOT NULL THEN jsonb_build_array(jsonb_build_object('userId', purchaser_id, 'at', purchaser_at, 'stage', 'purchaser', 'result', '采购通过')) ELSE '[]'::jsonb END
      WHERE approval_log = '[]'::jsonb`);
    await q.query(`UPDATE stocktake_tasks SET approval_log = jsonb_build_array(jsonb_build_object('userId', reviewer_id, 'at', reviewed_at, 'stage', 'review', 'result', CASE WHEN status = 'approved' THEN '复核通过' WHEN status = 'rejected' THEN '复核退回' ELSE '已复核（历史结果未保留）' END, 'note', review_note)) WHERE reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND approval_log = '[]'::jsonb`);
    await q.query(`UPDATE maintenance_orders SET approval_log = jsonb_build_array(jsonb_build_object('userId', inspector_id, 'at', inspected_at, 'stage', 'inspector', 'result', '已签字')) WHERE inspector_id IS NOT NULL AND inspected_at IS NOT NULL AND approval_log = '[]'::jsonb`);
  }
  async down(q: QueryRunner): Promise<void> {
    for (const table of ['purchase_requests', 'maintenance_orders', 'stocktake_tasks']) {
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS approval_log`);
    }
  }
}
