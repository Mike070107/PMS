import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Community,
  ManagementOffice,
  RepairExperienceFavorite,
  RepairExperienceNote,
  RepairTypeRule,
  StaffProfile,
  User,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { RepairExperienceAssetsController, RepairExperiencesController } from './repair-experiences.controller';
import { RepairExperiencesService } from './repair-experiences.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RepairExperienceNote,
      RepairExperienceFavorite,
      RepairTypeRule,
      Community,
      ManagementOffice,
      StaffProfile,
      User,
    ]),
    UploadModule,
  ],
  controllers: [RepairExperienceAssetsController, RepairExperiencesController],
  providers: [RepairExperiencesService],
})
export class RepairExperiencesModule {}
