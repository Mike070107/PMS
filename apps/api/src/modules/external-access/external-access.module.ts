import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalAccessApp, ExternalAccessGrant, User } from '../../entities';
import { CloudflareGatewayService } from './cloudflare-gateway.service';
import { ExternalAccessController } from './external-access.controller';
import { ExternalAccessService } from './external-access.service';

@Module({
  imports: [TypeOrmModule.forFeature([ExternalAccessApp, ExternalAccessGrant, User])],
  controllers: [ExternalAccessController],
  providers: [ExternalAccessService, CloudflareGatewayService],
})
export class ExternalAccessModule {}
