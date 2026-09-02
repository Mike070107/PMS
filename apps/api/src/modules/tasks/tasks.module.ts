import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RepairsModule } from '../repairs/repairs.module';
import { AuthModule } from '../auth/auth.module';
import { TasksService } from './tasks.service';
import { ObservabilityModule } from '../observability/observability.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ScheduleModule.forRoot(), RepairsModule, AuthModule, ObservabilityModule, NotificationsModule],
  providers: [TasksService],
})
export class TasksModule {}
