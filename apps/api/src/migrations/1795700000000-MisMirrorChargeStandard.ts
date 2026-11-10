import { MigrationInterface, QueryRunner } from 'typeorm';

/** WYDJ 原始标准镜像：保留四位金额、原始空值/历史标记；迁移不读取 MIS、不初始化水位。 */
export class MisMirrorChargeStandard1795700000000 implements MigrationInterface {
  name = 'MisMirrorChargeStandard1795700000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS mis_mirror_charge_standard (
      wy_dj_id bigint PRIMARY KEY,
      zh_id bigint NOT NULL,
      zl_id bigint,
      fee_code varchar(20),
      je numeric(19,4),
      bz numeric(19,4),
      is_history boolean,
      synced_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_mis_mirror_charge_standard_owner_fee
      ON mis_mirror_charge_standard(zh_id,fee_code) WHERE is_history=false`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS mis_mirror_charge_standard');
    // 回退再升级不能沿用旧成功水位，将空表误认作已同步。
    await q.query(`DELETE FROM mis_sync_state WHERE source_table='charge_standard'`);
  }
}
