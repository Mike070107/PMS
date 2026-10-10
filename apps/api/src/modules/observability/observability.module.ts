import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community, RequestMetric, SystemLog, User } from '../../entities';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClientTelemetryController, ObservabilityController } from './observability.controller';
import { ObservabilityInterceptor } from './observability.interceptor';
import { ObservabilityService } from './observability.service';

@Module({
  imports: [TypeOrmModule.forFeature([SystemLog, RequestMetric, User, Community]), NotificationsModule],
  controllers: [ClientTelemetryController, ObservabilityController],
  providers: [
    ObservabilityService,
    { provide: APP_INTERCEPTOR, useClass: ObservabilityInterceptor },
  ],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
