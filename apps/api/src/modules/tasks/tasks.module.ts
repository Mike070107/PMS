import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RepairsModule } from '../repairs/repairs.module';
import { AuthModule } from '../auth/auth.module';
import { TasksService } from './tasks.service';
import { ObservabilityModule } from '../observability/observability.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FeesModule } from '../fees/fees.module';

@Module({
  imports: [ScheduleModule.forRoot(), RepairsModule, AuthModule, ObservabilityModule, NotificationsModule, FeesModule],
  providers: [TasksService],
})
export class TasksModule {}
