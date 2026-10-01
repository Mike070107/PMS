import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalAccessApp, ExternalAccessGrant, LanGatewayAgent, User } from '../../entities';
import { CloudflareGatewayService } from './cloudflare-gateway.service';
import { ExternalAccessAgentController, ExternalAccessController } from './external-access.controller';
import { ExternalAccessService } from './external-access.service';
import { AuthModule } from '../auth/auth.module';
import { GatewayAccessController } from './gateway-access.controller';

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([ExternalAccessApp, ExternalAccessGrant, LanGatewayAgent, User])],
  controllers: [ExternalAccessController, ExternalAccessAgentController, GatewayAccessController],
  providers: [ExternalAccessService, CloudflareGatewayService],
})
export class ExternalAccessModule {}
