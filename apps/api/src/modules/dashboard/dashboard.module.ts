import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseRequest, UserAudit, WorkOrder } from '../../entities';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [TypeOrmModule.forFeature([WorkOrder, UserAudit, PurchaseRequest])],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
