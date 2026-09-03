import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ManagementOffice, RepairExperienceNote, RepairTypeRule, User } from '../../entities';
import { RepairExperiencesController } from './repair-experiences.controller';
import { RepairExperiencesService } from './repair-experiences.service';

@Module({
  imports: [TypeOrmModule.forFeature([RepairExperienceNote, RepairTypeRule, ManagementOffice, User])],
  controllers: [RepairExperiencesController],
  providers: [RepairExperiencesService],
})
export class RepairExperiencesModule {}
