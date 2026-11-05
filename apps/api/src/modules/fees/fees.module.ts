import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Building, Community, FeeBill, FeeStandard, House, User } from '../../entities';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { FeeTemplatesService } from './fee-templates.service';
import { FeeTemplatesController } from './fee-templates.controller';
import { MisFeesService } from './mis-fees.service';
import { SettingsModule } from '../settings/settings.module';
import { MisPostingService } from './mis-posting.service';
import { MisPostingConnector } from './mis-posting.connector';
import { MisPostingController } from './mis-posting.controller';
import { BusinessTransaction } from '../../entities/business-transaction.entity';
import { MisCollectionBatch } from '../../entities/mis-collection-batch.entity';

@Module({
  imports: [SettingsModule,
    TypeOrmModule.forFeature([BusinessTransaction, MisCollectionBatch, FeeBill, FeeStandard, House, Building, Community, User]),
  ],
  controllers: [FeesController, FeeTemplatesController, MisPostingController],
  providers: [FeesService, FeeTemplatesService, MisFeesService, MisPostingService, MisPostingConnector, { provide: 'MIS_POSTING_CONNECTOR', useExisting: MisPostingConnector }],
})
export class FeesModule {}
