import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

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
