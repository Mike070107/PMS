import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 「猜你想输」关键词改成公司模板 + 本处增补 / 屏蔽（2026-08-31）。
 *
 * 原来每个管理处第一次打开配置页时，把公司模板整套复制一份，之后彻底分家：
 * 公司层再补关键词，各管理处一个字都收不到，得逐处重配。关键词又同时是报修类型的
 * 判定依据（见 repair-classify.util.ts），词库被切碎的直接后果是同一句「电子门旋钮打滑」
 * 在 A 处判得出、B 处判不出，而且每处各攒各的数据，谁都攒不够。
 *
 * 改法：类型名 / 默认维修工 / 时限继续各管理处独立（维修工本来就只在自己管理处），
 * 只有关键词改成叠加：
 *   生效关键词 = 本处增补 ∪ （公司模板 − 本处屏蔽）
 *
 * 存量数据按这个口径拆开，界面上看不出变化：
 * - 本处有、模板没有的词 → extra_suggestions（本处特有叫法）
 * - 模板有、本处没有的词 → muted_suggestions（本处当初删过它，继续保持停用）
 * - 两边都有的 → 不用存，从模板继承
 *
 * 同时给管理处加两个「猜你想输」开关（排序口径、是否回流公司候选池）。
 */
export class RepairKeywordTemplate1788310800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE repair_type_rules ADD COLUMN IF NOT EXISTS extra_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE repair_type_rules ADD COLUMN IF NOT EXISTS muted_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE management_offices ADD COLUMN IF NOT EXISTS suggestion_scope varchar(20) NOT NULL DEFAULT 'office_first'`,
    );
    await queryRunner.query(
      `ALTER TABLE management_offices ADD COLUMN IF NOT EXISTS suggestion_feedback boolean NOT NULL DEFAULT true`,
    );

    // 有对应模板行的管理处规则：拆成「本处特有」和「本处停用」，重合的交还给模板
    await queryRunner.query(`
      UPDATE repair_type_rules r
      SET extra_suggestions = COALESCE((
            SELECT jsonb_agg(a.w ORDER BY a.ord)
            FROM jsonb_array_elements_text(r.content_suggestions) WITH ORDINALITY AS a(w, ord)
            WHERE NOT (t.content_suggestions @> to_jsonb(a.w))
          ), '[]'::jsonb),
          muted_suggestions = COALESCE((
            SELECT jsonb_agg(b.w ORDER BY b.ord)
            FROM jsonb_array_elements_text(t.content_suggestions) WITH ORDINALITY AS b(w, ord)
            WHERE NOT (r.content_suggestions @> to_jsonb(b.w))
          ), '[]'::jsonb),
          content_suggestions = '[]'::jsonb
      FROM repair_type_rules t
      WHERE r.office_id IS NOT NULL
        AND t.office_id IS NULL
        AND t.tenant_id = r.tenant_id
        AND t.repair_type = r.repair_type
    `);

    // 管理处自建、模板里根本没有的类型：整份词都是本处特有的
    await queryRunner.query(`
      UPDATE repair_type_rules r
      SET extra_suggestions = r.content_suggestions,
          content_suggestions = '[]'::jsonb
      WHERE r.office_id IS NOT NULL
        AND jsonb_array_length(r.content_suggestions) > 0
        AND NOT EXISTS (
          SELECT 1 FROM repair_type_rules t
          WHERE t.office_id IS NULL
            AND t.tenant_id = r.tenant_id
            AND t.repair_type = r.repair_type
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 把生效关键词摊回各管理处自己那一列，再删列 —— 回滚后行为和改造前一致
    await queryRunner.query(`
      UPDATE repair_type_rules r
      SET content_suggestions = COALESCE((
            SELECT jsonb_agg(m.w ORDER BY m.ord)
            FROM (
              SELECT a.w AS w, a.ord AS ord
                FROM jsonb_array_elements_text(r.extra_suggestions) WITH ORDINALITY AS a(w, ord)
              UNION ALL
              SELECT b.w, 1000 + b.ord
                FROM jsonb_array_elements_text(t.content_suggestions) WITH ORDINALITY AS b(w, ord)
               WHERE NOT (r.muted_suggestions @> to_jsonb(b.w))
            ) AS m
          ), '[]'::jsonb)
      FROM repair_type_rules t
      WHERE r.office_id IS NOT NULL
        AND t.office_id IS NULL
        AND t.tenant_id = r.tenant_id
        AND t.repair_type = r.repair_type
    `);
    await queryRunner.query(`
      UPDATE repair_type_rules r
      SET content_suggestions = r.extra_suggestions
      WHERE r.office_id IS NOT NULL
        AND jsonb_array_length(r.extra_suggestions) > 0
        AND NOT EXISTS (
          SELECT 1 FROM repair_type_rules t
          WHERE t.office_id IS NULL
            AND t.tenant_id = r.tenant_id
            AND t.repair_type = r.repair_type
        )
    `);
    await queryRunner.query(
      `ALTER TABLE repair_type_rules DROP COLUMN IF EXISTS extra_suggestions`,
    );
    await queryRunner.query(
      `ALTER TABLE repair_type_rules DROP COLUMN IF EXISTS muted_suggestions`,
    );
    await queryRunner.query(
      `ALTER TABLE management_offices DROP COLUMN IF EXISTS suggestion_scope`,
    );
    await queryRunner.query(
      `ALTER TABLE management_offices DROP COLUMN IF EXISTS suggestion_feedback`,
    );
  }
}
