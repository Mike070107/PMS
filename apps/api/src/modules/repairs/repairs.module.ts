import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiModule } from '../ai/ai.module';
import { SettingsModule } from '../settings/settings.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  CommunitySpot,
  House,
  Material,
  PurchaseRequest,
  RepairRequest,
  RepairTypeCorrection,
  RepairTypeRule,
  Review,
  Stock,
  StockLot,
  StockMovement,
  User,
  WorkOrder,
  WorkOrderLog,
  WorkOrderMaterial,
  WorkOrderMaterialAllocation,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { RepairsController } from './repairs.controller';
import { RepairsService } from './repairs.service';

@Module({
  imports: [
    // 派单/完工后给业主发通知
    NotificationsModule,
    SettingsModule,
    AiModule,
    TypeOrmModule.forFeature([
      Community,
      Building,
      CommunitySpot,
      House,
      Material,
      User,
      Stock,
      StockLot,
      StockMovement,
      RepairRequest,
      RepairTypeCorrection,
      RepairTypeRule,
      WorkOrder,
      WorkOrderLog,
      WorkOrderMaterial,
      WorkOrderMaterialAllocation,
      PurchaseRequest,
      Review,
    ]),
    UploadModule, // 附件读取要把私有桶地址翻成代理地址
  ],
  controllers: [RepairsController],
  providers: [RepairsService],
  exports: [RepairsService],
})
export class RepairsModule {}
