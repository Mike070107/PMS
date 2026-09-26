import 'reflect-metadata';
import { config as dotenv } from 'dotenv';
import { DataSource } from 'typeorm';
import { financeEntities } from './modules/finance/finance.entities';

dotenv();

export default new DataSource({
  type: 'postgres',
  host: process.env.FINANCE_DB_HOST ?? process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.FINANCE_DB_PORT ?? process.env.DB_PORT ?? '5432', 10),
  username: process.env.FINANCE_DB_USER ?? process.env.DB_USER ?? 'pms',
  password: process.env.FINANCE_DB_PASS ?? process.env.DB_PASS ?? '',
  database: process.env.FINANCE_DB_NAME ?? process.env.DB_NAME ?? 'pms_repair',
  entities: financeEntities,
  migrations: ['src/finance-migrations/*.ts'],
  synchronize: false,
});
