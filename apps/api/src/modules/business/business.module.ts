import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AccessCard,
  BusinessLog,
  BusinessRule,
  BusinessTransaction,
  Building,
  Community,
  House,
  ParkingOperation,
  ParkingVehicle,
  User,
} from '../../entities';
import { AccessCardIssuanceModule } from '../access-card-issuance/access-card-issuance.module';
import { BusinessExecutionService } from './business-execution.service';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

@Module({
  imports: [
    AccessCardIssuanceModule,
    TypeOrmModule.forFeature([
      AccessCard,
      BusinessLog,
      BusinessRule,
      BusinessTransaction,
      Building,
      Community,
      House,
      ParkingOperation,
      ParkingVehicle,
      User,
    ]),
  ],
  controllers: [BusinessController],
  providers: [BusinessService, BusinessExecutionService],
})
export class BusinessModule {}
