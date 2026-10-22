import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Building, Community, FeeBill, FeeStandard, House, User } from '../../entities';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { FeeTemplatesService } from './fee-templates.service';
import { FeeTemplatesController } from './fee-templates.controller';
import { MisFeesService } from './mis-fees.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([FeeBill, FeeStandard, House, Building, Community, User]),
  ],
  controllers: [FeesController, FeeTemplatesController],
  providers: [FeesService, FeeTemplatesService, MisFeesService],
})
export class FeesModule {}
