import { MigrationInterface, QueryRunner } from 'typeorm';

/** 缴费规则分组：车牌所属分组名最长 20 字，列放宽到 40（ALTER TYPE 不丢数据；不能交给 synchronize，它会删列重建） */
export class ParkingRuleGroups1792800000000 implements MigrationInterface {
  name = 'ParkingRuleGroups1792800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE IF EXISTS parking_plate_tags ALTER COLUMN vehicle_class TYPE varchar(40)`);
    await q.query(`ALTER TABLE IF EXISTS vehicle_intakes ALTER COLUMN vehicle_class TYPE varchar(40)`);
  }

  public async down(): Promise<void> {
    // 收窄可能截断分组名，不回退
  }
}
