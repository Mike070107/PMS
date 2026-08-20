import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Building, Community, QrCode } from '../../entities';
import { AuthModule } from '../auth/auth.module';
import { UploadModule } from '../upload/upload.module';
import { QrController } from './qr.controller';
import { QrService } from './qr.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([QrCode, Community, Building]),
    UploadModule,
    AuthModule, // WechatService：生成小程序码
  ],
  controllers: [QrController],
  providers: [QrService],
  exports: [QrService], // PropertiesService 新建楼栋时自动建码
})
export class QrModule {}
