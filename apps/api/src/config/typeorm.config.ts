import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { entities } from '../entities';
import { financeEntities } from '../modules/finance/finance.entities';

export function buildTypeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: config.get<string>('DB_HOST', 'localhost'),
    port: parseInt(config.get<string>('DB_PORT', '5432'), 10),
    username: config.get<string>('DB_USER', 'pms'),
    password: config.get<string>('DB_PASS', ''),
    database: config.get<string>('DB_NAME', 'pms_repair'),
    entities,
    // dev: synchronize 自动建表；prod 必须 false 走 migration
    synchronize: config.get<string>('DB_SYNCHRONIZE', 'false') === 'true',
    logging: config.get<string>('DB_LOGGING', 'false') === 'true',
  };
}

/**
 * 财务使用独立 TypeORM 连接。生产环境设置 FINANCE_DB_NAME 即可落到独立数据库；
 * 未设置时仅为本地兼容而复用主库，但仍使用完全独立的 finance_* 表。
 */
export function buildFinanceTypeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: config.get<string>('FINANCE_DB_HOST', config.get<string>('DB_HOST', 'localhost')),
    port: parseInt(config.get<string>('FINANCE_DB_PORT', config.get<string>('DB_PORT', '5432')), 10),
    username: config.get<string>('FINANCE_DB_USER', config.get<string>('DB_USER', 'pms')),
    password: config.get<string>('FINANCE_DB_PASS', config.get<string>('DB_PASS', '')),
    database: config.get<string>('FINANCE_DB_NAME', config.get<string>('DB_NAME', 'pms_repair')),
    entities: financeEntities,
    // 独立连接不能继承主库的自动同步开关；正式建表必须显式开启一次或执行审阅过的迁移。
    synchronize: config.get<string>('FINANCE_DB_SYNCHRONIZE', 'false') === 'true',
    logging: config.get<string>('DB_LOGGING', 'false') === 'true',
  };
}
