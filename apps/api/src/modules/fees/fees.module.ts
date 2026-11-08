import { MisCollectionPromise, MisCollectionHold, MisCollectionEvent, MisCollectionPrint } from '../../entities/mis-collection-followup.entity';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Building, Community, FeeBill, FeeStandard, House, TenantConfig, User } from '../../entities';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { MisMirrorService } from './mis-mirror.service';
import { FeeTemplatesService } from './fee-templates.service';
import { FeeTemplatesController } from './fee-templates.controller';
import { MisFeesService } from './mis-fees.service';
import { MisCollectionSmsService } from './mis-collection-sms.service';
import { CollectionTargetsService } from './collection-targets.service';
import { ScreenSettingsService } from './screen-settings.service';
import { ScreenSettingsController } from './screen-settings.controller';
import { SettingsModule } from '../settings/settings.module';
import { MisPostingService } from './mis-posting.service';
import { MisPostingConnector } from './mis-posting.connector';
import { MisPostingController } from './mis-posting.controller';
import { BusinessTransaction } from '../../entities/business-transaction.entity';
import { MisCollectionBatch } from '../../entities/mis-collection-batch.entity';

@Module({
  imports: [SettingsModule,
    TypeOrmModule.forFeature([MisCollectionPromise, MisCollectionHold, MisCollectionEvent, MisCollectionPrint, BusinessTransaction, MisCollectionBatch, FeeBill, FeeStandard, House, Building, Community, User, TenantConfig]),
  ],
  controllers: [ScreenSettingsController, FeesController, FeeTemplatesController, MisPostingController],
  providers: [FeesService, FeeTemplatesService, MisFeesService, MisCollectionSmsService, MisPostingService, MisPostingConnector, MisMirrorService, CollectionTargetsService, ScreenSettingsService, { provide: 'MIS_POSTING_CONNECTOR', useExisting: MisPostingConnector }],
  exports: [MisMirrorService],
})
export class FeesModule {}
