import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community, ManagementOffice, RoleScope } from '../../entities';
import { OfficesController } from './offices.controller';
import { OfficesService } from './offices.service';

@Module({
  imports: [TypeOrmModule.forFeature([ManagementOffice, Community, RoleScope])],
  controllers: [OfficesController],
  providers: [OfficesService],
})
export class OfficesModule {}
