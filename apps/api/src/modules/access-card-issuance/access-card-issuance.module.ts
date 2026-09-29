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
      AccessCardLegacyCardCheck,
      Building,
      Community,
      House,
    ]),
  ],
  controllers: [AccessCardIssuanceController, AccessCardAgentController],
  providers: [AccessCardIssuanceService],
})
export class AccessCardIssuanceModule {}
