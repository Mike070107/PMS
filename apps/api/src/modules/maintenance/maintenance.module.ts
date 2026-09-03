import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  House,
  MaintenanceOrder,
  MaintenanceSignSession,
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
import { NotificationsModule } from '../notifications/notifications.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
import { SignController } from './sign.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MaintenanceOrder,
      MaintenanceSignSession,
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
    NotificationsModule,
    // 手机签名链接用的短期 token：每次签名都显式传另一把密钥，这里不设默认 secret，
    // 免得哪天有人不小心用它签出一个能当登录态使的 token
    JwtModule.register({}),
  ],
  controllers: [MaintenanceController, SignController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
