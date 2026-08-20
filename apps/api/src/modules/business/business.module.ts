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
  ParkingVehicle,
  User,
} from '../../entities';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccessCard,
      BusinessLog,
      BusinessRule,
      BusinessTransaction,
      Building,
      Community,
      House,
      ParkingVehicle,
      User,
    ]),
  ],
  controllers: [BusinessController],
  providers: [BusinessService],
})
export class BusinessModule {}
