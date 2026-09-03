import { MigrationInterface, QueryRunner } from 'typeorm';

export class MaintenanceSigningWorkflow1789002000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE maintenance_orders
         SET status = CASE
           WHEN status = 'inspected' OR inspector_sign_url IS NOT NULL THEN 'pending_print'
           WHEN repairer_sign_url IS NOT NULL THEN 'waiting_inspector'
           WHEN filler_sign_url IS NOT NULL THEN 'waiting_repairer'
           ELSE 'filling'
         END
       WHERE status IN ('draft', 'inspected')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE maintenance_orders
         SET status = CASE WHEN status IN ('pending_print', 'completed') THEN 'inspected' ELSE 'draft' END
       WHERE status IN ('filling', 'waiting_filler', 'waiting_repairer', 'waiting_inspector', 'pending_print', 'completed')
    `);
  }
}
