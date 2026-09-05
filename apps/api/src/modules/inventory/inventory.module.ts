import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  GoodsReceipt,
  Material,
  Notification,
  PurchaseOrder,
  PurchaseRequest,
  StaffProfile,
  Stock,
  StockLot,
  StockMovement,
  Supplier,
  TransferOrder,
  User,
  Warehouse,
  WarehouseLocation,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    // 材料照片存的是私有桶地址，返回前要翻成代理地址才显示得出来
    UploadModule,
    // 采购审批链配置（办公室 / 经理 / 采购 开关与阈值）
    SettingsModule,
    // 控制器在操作成功后把指向这张单的站内信标已读（markReadByRef）。
    // 2026-09-06 漏了这一行直接上线，Nest 起不来、线上 502 了几分钟 —— 加注入必看模块 imports。
    NotificationsModule,
    TypeOrmModule.forFeature([
      Material,
      Warehouse,
      Supplier,
      Stock,
      StockLot,
      StockMovement,
      PurchaseRequest,
      PurchaseOrder,
      GoodsReceipt,
      TransferOrder,
      Notification,
      StaffProfile,
      User,
      WarehouseLocation,
    ]),
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
