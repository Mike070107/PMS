import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { LlmService } from './llm.service';
import { RepairTextAiService } from './repair-text.ai';

/**
 * 大模型相关的东西都收在这里，别散到业务模块里去 ——
 * 换服务商、加一个用得上模型的地方，都只动这一个模块。
 */
@Module({
  imports: [SettingsModule],
  controllers: [AiController],
  providers: [LlmService, RepairTextAiService],
  exports: [LlmService, RepairTextAiService],
})
export class AiModule {}
