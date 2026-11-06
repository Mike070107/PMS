import type { MigrationInterface, QueryRunner } from 'typeorm';
export class UserUiPreferences1793890000000 implements MigrationInterface {
 name='UserUiPreferences1793890000000';
 async up(q:QueryRunner):Promise<void>{await q.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_preferences jsonb NOT NULL DEFAULT '{}'::jsonb`)}
 async down():Promise<void>{throw new Error('保留个人配置，禁止自动删除；需要回退应用时保留新增列。')}
}
