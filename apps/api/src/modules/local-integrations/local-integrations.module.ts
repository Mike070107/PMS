import { Module } from '@nestjs/common';
import { StandardParkingQueryService } from './standard-parking-query.service';
import { StandardCardIssuanceService } from './standard-card-issuance.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { LocalIntegrationsService } from './local-integrations.service';
import { LocalIntegrationAgentController, LocalIntegrationsController } from './local-integrations.controller';
@Module({
  imports: [TypeOrmModule.forFeature([LocalIntegration, LocalIntegrationTask])],
  controllers: [LocalIntegrationsController, LocalIntegrationAgentController],
  providers: [LocalIntegrationsService, StandardCardIssuanceService, StandardParkingQueryService], exports: [LocalIntegrationsService, StandardCardIssuanceService, StandardParkingQueryService],
})
export class LocalIntegrationsModule {}
