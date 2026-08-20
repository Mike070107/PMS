import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { entities } from '../entities';

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
