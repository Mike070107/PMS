import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as dotenv } from 'dotenv';
import { entities } from './entities';

dotenv();

/** TypeORM CLI 用的数据源（生成/执行迁移） */
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'pms',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'pms_repair',
  entities,
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});
