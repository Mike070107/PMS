import { Body, Controller, ForbiddenException, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { Community, Material, WorkOrder } from '../../entities';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import {
  matchCompletionMaterials,
  RepairTextAiService,
  validateCompletionFeeRule,
} from './repair-text.ai';
import { RepairFeeRulesService } from './repair-fee-rules.service';

class CompletionSummaryDto {
  @IsString()
  @MaxLength(1000)
  text: string;

  /** 带上工单后才能按本单类型匹配收费规则，并校验只能给自己的在手工单生成草稿 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  workOrderId?: number;
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
  constructor(
    private readonly repairTextAi: RepairTextAiService,
    private readonly feeRules: RepairFeeRulesService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * 完工小结：维修工口述一句，理成规范的维修记录。
   *
   * 没配大模型 / 调不通 / 超时时返回 { ok: false }，端上把原话原样填进「维修说明」——
   * 少整理一次而已，绝不能因此让人交不了工单。
   */
  @Post('completion-summary')
  @RequirePermission('app:my-orders', 'edit')
  async completionSummary(@Body() dto: CompletionSummaryDto, @CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId as number;
    let workOrder: WorkOrder | null = null;
    if (dto.workOrderId) {
      workOrder = await this.dataSource.getRepository(WorkOrder).findOne({
        where: { id: dto.workOrderId, tenantId },
      });
      if (!workOrder) throw new NotFoundException('工单不存在');
      if (workOrder.assigneeId !== user.id) {
        throw new ForbiddenException('只能为自己的在手工单生成完工草稿');
      }
    }

    let officeId: number | null = null;
    if (workOrder) {
      const community = await this.dataSource.getRepository(Community).findOne({
        where: { id: workOrder.communityId, tenantId },
      });
      if (community) {
        const parent = community.parentId
          ? await this.dataSource.getRepository(Community).findOne({
              where: { id: community.parentId, tenantId },
            })
          : null;
        officeId = community.officeId ?? parent?.officeId ?? null;
      }
    }
    const rules = workOrder
      ? (await this.feeRules.list(tenantId, true))
          .filter(
            (rule) =>
              (!rule.repairType || rule.repairType === workOrder?.skill) &&
              (!rule.officeId || rule.officeId === officeId),
          )
          // 同一场景同时有公司规则和本处规则时，让本处规则先出现。
          .sort((a, b) => Number(!!b.officeId) - Number(!!a.officeId))
          .slice(0, 50)
      : [];
    const summary = await this.repairTextAi.summarizeCompletion(
      tenantId,
      dto.text,
      rules,
    );
    if (!summary) return { ok: false as const };

    const catalog = workOrder
      ? await this.dataSource.getRepository(Material).find({
          where: { tenantId, enabled: true },
          order: { id: 'ASC' },
        })
      : [];
    const feeRule = validateCompletionFeeRule(
      summary.feeRuleCode,
      rules,
      `${dto.text} ${summary.actionNote}`,
    );
    return {
      ok: true as const,
      actionNote: summary.actionNote,
      faultLocation: summary.faultLocation,
      faultSymptom: summary.faultSymptom,
      // 老版本小程序仍把它当字符串数组展示，保持兼容；新版本读 materialSuggestions。
      materials: summary.materials.map((item) => item.name),
      materialSuggestions: matchCompletionMaterials(summary.materials, catalog),
      feeSuggestion: feeRule
        ? {
            ruleCode: feeRule.code,
            ruleName: feeRule.name,
            feeCents: feeRule.feeCents,
            basis: `按收费标准「${feeRule.name}」`,
          }
        : null,
      /** 端上随最终提交带回，服务端只用于计算人工纠错差异，不参与扣费/扣库存。 */
      draft: {
        actionNote: summary.actionNote,
        faultLocation: summary.faultLocation,
        faultSymptom: summary.faultSymptom,
        materials: summary.materials.map((item) => item.name),
        feeRuleCode: feeRule?.code ?? '',
        feeCents: feeRule?.feeCents ?? null,
      },
    };
  }
}
