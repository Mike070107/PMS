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
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [
    // 材料照片存的是私有桶地址，返回前要翻成代理地址才显示得出来
    UploadModule,
    // 采购审批链配置（办公室 / 经理 / 采购 开关与阈值）
    SettingsModule,
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
