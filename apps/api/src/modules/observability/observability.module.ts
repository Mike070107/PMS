import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestMetric, SystemLog, User } from '../../entities';
import { ClientTelemetryController, ObservabilityController } from './observability.controller';
import { ObservabilityInterceptor } from './observability.interceptor';
import { ObservabilityService } from './observability.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemLog, RequestMetric, User])],
  controllers: [ClientTelemetryController, ObservabilityController],
  providers: [
    ObservabilityService,
    { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  ],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
