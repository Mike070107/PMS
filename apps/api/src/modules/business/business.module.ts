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
  VehicleIntake,
  ParkingPlateTag,
} from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { VehicleIntakeController, VehicleIntakeFormController } from './vehicle-intake.controller';
import { VehicleIntakeService } from './vehicle-intake.service';
import { AccessCardIssuanceModule } from '../access-card-issuance/access-card-issuance.module';
import { BusinessExecutionService } from './business-execution.service';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

@Module({
  imports: [
    AccessCardIssuanceModule,
    UploadModule,
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
      VehicleIntake,
      ParkingPlateTag,
    ]),
  ],
  controllers: [BusinessController, VehicleIntakeController, VehicleIntakeFormController],
  providers: [BusinessService, BusinessExecutionService, VehicleIntakeService],
})
export class BusinessModule {}
