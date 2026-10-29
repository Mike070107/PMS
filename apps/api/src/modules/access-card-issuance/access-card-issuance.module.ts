import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AccessCardAgent,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacySnapshot,
  AccessCardLegacyCardCheck,
  AccessCardAuthorization,
  Building,
  Community,
  FamilyCar,
  House,
  ParkingQuery,
  ParkingOwnerUpdate,
  ParkingProofUpload,
  ParkingHistory,
  ParkingRecordSnapshot,
  ParkingOperation,
  TenantConfig,
  User,
} from '../../entities';
import { AccessCardAgentController, AccessCardIssuanceController, ParkingProofController } from './access-card-issuance.controller';
import { AccessCardIssuanceService } from './access-card-issuance.service';
import { FAMILY_CAR_SERVICE, ParkingProofService } from './parking-proof.service';
import { UploadModule } from '../upload/upload.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FamilyCarController } from './family-car.controller';
import { FamilyCarService } from './family-car.service';
import { DeliyunParkingService } from './deliyun-parking.service';

@Module({
  imports: [
    UploadModule,
    NotificationsModule,
    TypeOrmModule.forFeature([
      AccessCardAgent,
      AccessCardIssueBatch,
      AccessCardIssueItem,
      AccessCardLegacySnapshot,
      AccessCardLegacyCardCheck,
      AccessCardAuthorization,
      Building,
      Community,
      FamilyCar,
      House,
      ParkingQuery,
      ParkingOwnerUpdate,
      ParkingProofUpload,
      ParkingHistory,
      ParkingRecordSnapshot,
      ParkingOperation,
      TenantConfig,
      User,
    ]),
  ],
  controllers: [AccessCardIssuanceController, AccessCardAgentController, ParkingProofController, FamilyCarController],
  providers: [
    AccessCardIssuanceService,
    ParkingProofService,
    DeliyunParkingService,
    FamilyCarService,
    { provide: FAMILY_CAR_SERVICE, useExisting: FamilyCarService },
  ],
  exports: [DeliyunParkingService, AccessCardIssuanceService],
})
export class AccessCardIssuanceModule {}
