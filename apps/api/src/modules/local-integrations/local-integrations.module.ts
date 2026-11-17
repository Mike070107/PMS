import { Module } from '@nestjs/common';
import { StandardCardIssuanceService } from './standard-card-issuance.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocalIntegration, LocalIntegrationTask } from '../../entities/local-integration.entity';
import { LocalIntegrationsService } from './local-integrations.service';
import { LocalIntegrationAgentController, LocalIntegrationsController } from './local-integrations.controller';
@Module({
  imports: [TypeOrmModule.forFeature([LocalIntegration, LocalIntegrationTask])],
  controllers: [LocalIntegrationsController, LocalIntegrationAgentController],
  providers: [LocalIntegrationsService, StandardCardIssuanceService], exports: [LocalIntegrationsService, StandardCardIssuanceService],
})
export class LocalIntegrationsModule {}
