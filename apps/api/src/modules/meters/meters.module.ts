import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  House,
  Meter,
  MeterCharge,
  MeterOcrSample,
  MeterReading,
  User,
} from '../../entities';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { MeterOcrService } from './meter-ocr.service';
import { MetersController } from './meters.controller';
import { MetersService } from './meters.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Meter, MeterReading, MeterCharge, MeterOcrSample, Community, House, Building, User]),
    UploadModule,
    AiModule,
    AuthModule,
  ],
  controllers: [MetersController],
  providers: [MetersService, MeterOcrService],
  exports: [MetersService],
})
export class MetersModule {}
