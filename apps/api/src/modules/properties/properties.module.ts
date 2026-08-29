import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  House,
  ManagementOffice,
  Unit,
  User,
  WorkOrder,
} from '../../entities';
import { QrModule } from '../qr/qr.module';
import { PropertiesController } from './properties.controller';
import { PropertiesService } from './properties.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Community,
      Building,
      Unit,
      House,
      User,
      WorkOrder,
      ManagementOffice,
    ]),
    QrModule, // 新建楼栋时自动生成楼栋小程序码
  ],
  controllers: [PropertiesController],
  providers: [PropertiesService],
})
export class PropertiesModule {}
