import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { AccessModule } from './modules/access/access.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { OfficesModule } from './modules/offices/offices.module';
import { PlatformModule } from './modules/platform/platform.module';
import { RolesModule } from './modules/roles/roles.module';
import { BusinessModule } from './modules/business/business.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { FeesModule } from './modules/fees/fees.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OwnersModule } from './modules/owners/owners.module';
import { OwnersMgmtModule } from './modules/owners-mgmt/owners-mgmt.module';
import { PropertiesModule } from './modules/properties/properties.module';
import { QrModule } from './modules/qr/qr.module';
import { RepairsModule } from './modules/repairs/repairs.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StaffModule } from './modules/staff/staff.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { UploadModule } from './modules/upload/upload.module';
import { StocktakeModule } from './modules/stocktake/stocktake.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildTypeOrmOptions(config),
    }),
    AccessModule,
    AiModule,
    AuthModule,
    BusinessModule,
    OfficesModule,
    PlatformModule,
    RolesModule,
    DashboardModule,
    FeesModule,
    HealthModule,
    InventoryModule,
    MaintenanceModule,
    NotificationsModule,
    UploadModule,
    StocktakeModule,
    PropertiesModule,
    QrModule,
    OwnersModule,
    OwnersMgmtModule,
    RepairsModule,
    ReportsModule,
    SettingsModule,
    StaffModule,
    TasksModule,
  ],
})
export class AppModule {}
