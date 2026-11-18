import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AccessCardIssuanceModule } from '../access-card-issuance/access-card-issuance.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StocktakeModule } from '../stocktake/stocktake.module';
import { BusinessModule } from '../business/business.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [InventoryModule, AccessCardIssuanceModule, MaintenanceModule, BusinessModule, StocktakeModule, NotificationsModule],
  controllers: [ApprovalsController], providers: [ApprovalsService],
})
export class ApprovalsModule {}
