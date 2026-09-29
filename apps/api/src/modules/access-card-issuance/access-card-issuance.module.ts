import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AccessCardAgent,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacySnapshot,
  Building,
  Community,
  House,
  ParkingQuery,
} from '../../entities';
import { AccessCardAgentController, AccessCardIssuanceController } from './access-card-issuance.controller';
import { AccessCardIssuanceService } from './access-card-issuance.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccessCardAgent,
      AccessCardIssueBatch,
      AccessCardIssueItem,
      AccessCardLegacySnapshot,
      Building,
      Community,
      House,
      ParkingQuery,
    ]),
  ],
  controllers: [AccessCardIssuanceController, AccessCardAgentController],
  providers: [AccessCardIssuanceService],
})
export class AccessCardIssuanceModule {}
