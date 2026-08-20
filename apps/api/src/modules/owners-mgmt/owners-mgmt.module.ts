import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { House, User, UserReportCommunity } from '../../entities';
import { OwnersMgmtController } from './owners-mgmt.controller';
import { OwnersMgmtService } from './owners-mgmt.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, House, UserReportCommunity])],
  controllers: [OwnersMgmtController],
  providers: [OwnersMgmtService],
})
export class OwnersMgmtModule {}
