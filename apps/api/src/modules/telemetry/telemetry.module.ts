import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoginAttempt } from '../../entities/login-attempt.entity';
import { PageView } from '../../entities/page-view.entity';
import { User } from '../../entities/user.entity';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

@Module({
  imports: [TypeOrmModule.forFeature([PageView, LoginAttempt, User])],
  controllers: [TelemetryController],
  providers: [TelemetryService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
