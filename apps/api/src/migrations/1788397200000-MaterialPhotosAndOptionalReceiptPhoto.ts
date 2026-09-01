import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 材料多图（2026-09-01）。
 *
 * 一张照片认不出一件材料：正面、侧面、铭牌、包装各一张才够维修工比对。
 * 单开 photo_urls 数组，photo_url 保留成「第一张」——
 * 列表页、选料弹层、工单里几十处只要一张缩略图，改成读数组会是一次全库改动，
 * 而两份数据由服务端在写入时同步（见 InventoryService.normalizePhotoUrls）。
 */
export class MaterialPhotosAndOptionalReceiptPhoto1788397200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE materials ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    // 存量单图搬进数组，否则老 SKU 打开编辑器是「一张图都没有」
    await queryRunner.query(`
      UPDATE materials
         SET photo_urls = jsonb_build_array(photo_url)
       WHERE photo_url IS NOT NULL
         AND btrim(photo_url) <> ''
         AND photo_urls = '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE materials DROP COLUMN IF EXISTS photo_urls`);
  }
}
