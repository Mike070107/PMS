import { Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';
import { UploadController } from './upload.controller';

@Module({
  controllers: [UploadController],
  providers: [ObjectStorageService],
  exports: [ObjectStorageService],
})
export class UploadModule {}
