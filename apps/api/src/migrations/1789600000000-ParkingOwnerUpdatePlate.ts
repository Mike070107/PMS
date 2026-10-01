import { MigrationInterface, QueryRunner } from 'typeorm';

export class ParkingOwnerUpdatePlate1789600000000 implements MigrationInterface {
  name = 'ParkingOwnerUpdatePlate1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "parking_owner_updates" ADD COLUMN "plate" varchar(100)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "parking_owner_updates" DROP COLUMN "plate"');
  }
}
