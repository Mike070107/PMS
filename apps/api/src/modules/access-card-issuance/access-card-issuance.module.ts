import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AccessCardAgent,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacySnapshot,
  AccessCardLegacyCardCheck,
  Building,
  Community,
  House,
  ParkingQuery,
  ParkingProofUpload,
  ParkingHistory,
  ParkingRecordSnapshot,
  User,
} from '../../entities';
import { AccessCardAgentController, AccessCardIssuanceController, ParkingProofController } from './access-card-issuance.controller';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { ParkingProofService } from './parking-proof.service';
import { UploadModule } from '../upload/upload.module';
import { DeliyunParkingService } from './deliyun-parking.service';

@Module({
  imports: [
    UploadModule,
    TypeOrmModule.forFeature([
      AccessCardAgent,
      AccessCardIssueBatch,
      AccessCardIssueItem,
      AccessCardLegacySnapshot,
      AccessCardLegacyCardCheck,
      Building,
      Community,
      House,
      ParkingQuery,
      ParkingProofUpload,
      ParkingHistory,
      ParkingRecordSnapshot,
      User,
    ]),
  ],
  controllers: [AccessCardIssuanceController, AccessCardAgentController, ParkingProofController],
  providers: [AccessCardIssuanceService, ParkingProofService, DeliyunParkingService],
})
export class AccessCardIssuanceModule {}
