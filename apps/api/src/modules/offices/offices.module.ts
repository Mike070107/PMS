import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community, ManagementOffice, RepairTypeRule, RoleScope, Warehouse } from '../../entities';
import { OfficesController } from './offices.controller';
import { OfficesService } from './offices.service';

@Module({
  imports: [TypeOrmModule.forFeature([ManagementOffice, Community, RoleScope, RepairTypeRule, Warehouse])],
  controllers: [OfficesController],
  providers: [OfficesService],
})
export class OfficesModule {}
