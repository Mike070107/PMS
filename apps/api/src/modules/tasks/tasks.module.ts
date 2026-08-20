import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RepairsModule } from '../repairs/repairs.module';
import { TasksService } from './tasks.service';

@Module({
  imports: [ScheduleModule.forRoot(), RepairsModule],
  providers: [TasksService],
})
export class TasksModule {}
