import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AiAssistFeedback,
  AiExtractSample,
  AiResultCache,
  AiUsageLog,
  Material,
  RepairFeeRule,
  WorkOrder,
} from '../../entities';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiToolsController } from './ai-tools.controller';
import { MaterialReceiptController } from './material-receipt.controller';
import { MaterialReceiptAiService } from './material-receipt.ai';
import { ExtractSamplesService } from './extract-samples.service';
import { LlmService } from './llm.service';
import { RepairTextAiService } from './repair-text.ai';
import { AiFeedbackService } from './ai-feedback.service';
import { RepairFeeRulesService } from './repair-fee-rules.service';
import { AiUsageService } from './ai-usage.service';

/**
 * 大模型相关的东西都收在这里，别散到业务模块里去 ——
 * 换服务商、加一个用得上模型的地方，都只动这一个模块。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AiExtractSample,
      AiAssistFeedback,
      AiUsageLog,
      AiResultCache,
      Material,
      RepairFeeRule,
      WorkOrder,
    ]),
    SettingsModule,
  ],
  controllers: [AiController, AiToolsController, MaterialReceiptController],
  providers: [
    AiUsageService,
    LlmService,
    RepairTextAiService,
    MaterialReceiptAiService,
    ExtractSamplesService,
    AiFeedbackService,
    RepairFeeRulesService,
  ],
  exports: [
    AiUsageService,
    LlmService,
    RepairTextAiService,
    MaterialReceiptAiService,
    ExtractSamplesService,
    AiFeedbackService,
    RepairFeeRulesService,
  ],
})
export class AiModule {}
