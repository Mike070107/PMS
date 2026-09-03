import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ManagementOffice,
  RepairExperienceNote,
  RepairTypeRule,
  StaffProfile,
  User,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { RepairExperiencesController } from './repair-experiences.controller';
import { RepairExperiencesService } from './repair-experiences.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([RepairExperienceNote, RepairTypeRule, ManagementOffice, StaffProfile, User]),
    UploadModule,
  ],
  controllers: [RepairExperiencesController],
  providers: [RepairExperiencesService],
})
export class RepairExperiencesModule {}
