import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities';
import { UploadModule } from '../upload/upload.module';
import { AiModule } from '../ai/ai.module';
import { financeEntities } from './finance.entities';
import { FinanceController } from './finance.controller';
import { FinanceFilesService } from './finance-files.service';
import { FinanceMailService } from './finance-mail.service';
import { FinanceService } from './finance.service';
import { FinanceRecognitionService } from './finance-recognition.service';
import { FinanceTaxImportService } from './finance-tax-import.service';
import { FinanceVerificationService } from './finance-verification.service';

@Module({
  imports: [TypeOrmModule.forFeature(financeEntities, 'finance'), TypeOrmModule.forFeature([User]), UploadModule, AiModule],
  controllers: [FinanceController],
  providers: [FinanceService, FinanceMailService, FinanceFilesService, FinanceRecognitionService, FinanceTaxImportService, FinanceVerificationService],
})
export class FinanceModule {}
