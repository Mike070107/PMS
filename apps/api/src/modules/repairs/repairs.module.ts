import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  House,
  Material,
  PurchaseRequest,
  RepairRequest,
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
    TypeOrmModule.forFeature([
      Community,
      Building,
      House,
      Material,
      User,
      Stock,
      StockLot,
      StockMovement,
      RepairRequest,
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
