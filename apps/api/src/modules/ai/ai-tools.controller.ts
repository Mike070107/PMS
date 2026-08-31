import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { RepairTextAiService } from './repair-text.ai';

class CompletionSummaryDto {
  @IsString()
  @MaxLength(1000)
  text: string;
}

/**
 * 干活的人用得上的 AI 小工具。
 *
 * 和 settings/ai 那个控制器分开的原因是**权限不同**：那边是管理员配服务商用的
 * （settings 权限），这边是维修工在现场用的（工单权限）—— 混在一起的话，
 * 维修工要么用不了，要么就得给他开后台设置权限。
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AiToolsController {
  constructor(private readonly repairTextAi: RepairTextAiService) {}

  /**
   * 完工小结：维修工口述一句，理成规范的维修记录。
   *
   * 没配大模型 / 调不通 / 超时时返回 { ok: false }，端上把原话原样填进「维修说明」——
   * 少整理一次而已，绝不能因此让人交不了工单。
   */
  @Post('completion-summary')
  @RequirePermission('app:my-orders', 'edit')
  async completionSummary(@Body() dto: CompletionSummaryDto, @CurrentUser() user: AuthUser) {
    const summary = await this.repairTextAi.summarizeCompletion(
      user.tenantId as number,
      dto.text,
    );
    return summary ? { ok: true as const, ...summary } : { ok: false as const };
  }
}
