import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../../entities';
import { ArrearsStatisticsService } from './arrears.service';
import { CollectionStatisticsService } from './collection.service';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [TypeOrmModule.forFeature([Community])],
  controllers: [StatisticsController],
  providers: [StatisticsService, CollectionStatisticsService, ArrearsStatisticsService],
})
export class StatisticsModule {}
