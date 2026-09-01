import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiAssistFeedback, AiExtractSample, RepairFeeRule } from '../../entities';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiToolsController } from './ai-tools.controller';
import { ExtractSamplesService } from './extract-samples.service';
import { LlmService } from './llm.service';
import { RepairTextAiService } from './repair-text.ai';
import { AiFeedbackService } from './ai-feedback.service';
import { RepairFeeRulesService } from './repair-fee-rules.service';

/**
 * 大模型相关的东西都收在这里，别散到业务模块里去 ——
 * 换服务商、加一个用得上模型的地方，都只动这一个模块。
 */
@Module({
  imports: [TypeOrmModule.forFeature([AiExtractSample, AiAssistFeedback, RepairFeeRule]), SettingsModule],
  controllers: [AiController, AiToolsController],
  providers: [
    LlmService,
    RepairTextAiService,
    ExtractSamplesService,
    AiFeedbackService,
    RepairFeeRulesService,
  ],
  exports: [
    LlmService,
    RepairTextAiService,
    ExtractSamplesService,
    AiFeedbackService,
    RepairFeeRulesService,
  ],
})
export class AiModule {}
