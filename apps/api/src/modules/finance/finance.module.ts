import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { financeEntities } from './finance.entities';
import { FinanceController } from './finance.controller';
import { FinanceFilesService } from './finance-files.service';
import { FinanceMailService } from './finance-mail.service';
import { FinanceService } from './finance.service';

@Module({
  imports: [TypeOrmModule.forFeature(financeEntities, 'finance'), TypeOrmModule.forFeature([User]), UploadModule],
  controllers: [FinanceController],
  providers: [FinanceService, FinanceMailService, FinanceFilesService],
})
export class FinanceModule {}
