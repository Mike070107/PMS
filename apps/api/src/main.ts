import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Express 默认只收 100kb 的 JSON。存量数据导入（老收费系统的账单一次几千行）
  // 会直接被顶回 413，而且报错信息里看不出是体积问题。附件走 multipart，不受这里影响。
  //
  // 用 app.useBodyParser 而不是 `import { json } from 'express'`：express 只是
  // @nestjs/platform-express 的传递依赖，没写进本包的 dependencies，pnpm deploy --prod
  // 打出来的产物里它不在顶层 node_modules，线上会直接 MODULE_NOT_FOUND 起不来
  // （2026-08-26 就这么把线上打挂过一次）。
  app.useBodyParser('json', { limit: '20mb' });
  app.useBodyParser('urlencoded', { limit: '20mb', extended: true });

  app.setGlobalPrefix(config.get<string>('API_GLOBAL_PREFIX', 'api/v1'));
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const port = parseInt(config.get<string>('PORT', '4000'), 10);
  const host = config.get<string>('HOST', '0.0.0.0');
  await app.listen(port, host);
  Logger.log(`PMS Repair API listening on ${host}:${port}`, 'Bootstrap');
}
bootstrap();
