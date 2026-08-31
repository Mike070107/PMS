import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  House,
  MaintenanceOrder,
  ManagementOffice,
  Material,
  QuotaItem,
  RepairRequest,
  RepairTypeRule,
  TenantConfig,
  User,
  WorkOrder,
  WorkOrderMaterial,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MaintenanceOrder,
      QuotaItem,
      TenantConfig,
      WorkOrder,
      WorkOrderMaterial,
      RepairRequest,
      RepairTypeRule,
      House,
      Building,
      Community,
      ManagementOffice,
      Material,
      User,
    ]),
    UploadModule, // 手写签名存在私有桶里，读的时候要翻成代理地址
  ],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
