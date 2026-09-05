import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { ExtractSamplesService } from './extract-samples.service';
import { RepairTextAiService } from './repair-text.ai';
import { LlmService } from './llm.service';
import { AiFeedbackService } from './ai-feedback.service';
import { RepairFeeRulesService } from './repair-fee-rules.service';
import { AiUsageService } from './ai-usage.service';
import { SettingsService } from '../settings/settings.service';

/**
 * 「发送测试」用的入参：允许带上页面里**还没保存**的那几个值，
 * 管理员填完就能点测试，不用先保存再测（填错了还得回去改，来回两趟）。
 * apiKey 传脱敏串或留空时用库里存的那一份（见 LlmService.testConnection）。
 */
class TestAiDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(200) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(80) model?: string;
  @IsOptional() @IsString() @MaxLength(200) apiKey?: string;
  @IsOptional() @IsInt() @Min(1000) @Max(30000) timeoutMs?: number;
}

/** 识别样例：「这么说 → 应该这么认」。expected 的字段和模型输出对齐 */
class SampleDto {
  /** repair = 一句话报修；completion = 完工小结。两边的提示词各取各的样例 */
  @IsOptional() @IsString() @MaxLength(20) kind?: string;
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsObject() expected?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class FeeRuleDto {
  @IsString() @MaxLength(60) @Matches(/^[a-zA-Z0-9_-]+$/) code: string;
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(60) repairType?: string;
  @IsOptional() @IsInt() @Min(1) officeId?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @IsInt() @Min(0) @Max(100000000) feeCents: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('settings/ai')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AiController {
  constructor(
    private readonly llm: LlmService,
    private readonly samples: ExtractSamplesService,
    private readonly feedback: AiFeedbackService,
    private readonly feeRules: RepairFeeRulesService,
    private readonly usage: AiUsageService,
    private readonly settings: SettingsService,
  ) {}

  /** 本月用量：调用次数、token、两种缓存命中、估算费用（后台填了单价才有）。month=YYYY-MM，缺省当月 */
  @Get('usage')
  @RequirePermission('settings', 'view')
  async usageSummary(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    const tenantId = user.tenantId as number;
    const cfg = await this.settings.getAiAssistRaw(tenantId);
    return this.usage.summary(tenantId, month, cfg);
  }


  /**
   * 连通性测试。**把服务商返回的原话带回去** ——「调用失败」四个字帮不了任何人，
   * 是 key 写错了、余额没了还是模型名不存在，只有原文说得清。
   */
  @Post('test')
  @RequirePermission('settings', 'edit')
  test(@Body() dto: TestAiDto, @CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId as number;
    return this.llm.testConnection(tenantId, dto);
  }

  /**
   * 识别样例的增删改查。
   *
   * 存在的意义：遇到一种没见过的说法，办公室自己加一条就行，不用改代码重新发版
   * （2026-09-01 用户要求：已经处理过的正例要让 AI 记住，别每次重讲一遍规则）。
   * 每一条都会进下一次调用的提示词，所以**条数要克制**，见 ExtractSamplesService。
   */
  @Get('samples')
  @RequirePermission('settings', 'view')
  listSamples(@CurrentUser() user: AuthUser, @Query('kind') kind?: string) {
    return this.samples.list(user.tenantId as number, kind === 'completion' ? 'completion' : 'repair');
  }

  @Post('samples')
  @RequirePermission('settings', 'edit')
  createSample(@Body() dto: SampleDto, @CurrentUser() user: AuthUser) {
    return this.samples.create(user.tenantId as number, user.id, {
      text: dto.text ?? '',
      expected: dto.expected ?? {},
      note: dto.note,
      kind: dto.kind,
    });
  }

  @Patch('samples/:id')
  @RequirePermission('settings', 'edit')
  updateSample(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SampleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.samples.update(user.tenantId as number, user.id, id, dto);
  }

  @Delete('samples/:id')
  @RequirePermission('settings', 'edit')
  removeSample(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.samples.remove(user.tenantId as number, id);
  }

  @Get('feedback')
  @RequirePermission('settings', 'view')
  listFeedback(
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
  ) {
    return this.feedback.list(user.tenantId as number, user, access, kind, status);
  }

  @Post('feedback/:id/promote')
  @RequirePermission('settings', 'edit')
  promoteFeedback(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feedback.promote(user.tenantId as number, user, access, id);
  }

  @Post('feedback/:id/ignore')
  @RequirePermission('settings', 'edit')
  ignoreFeedback(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feedback.ignore(user.tenantId as number, user, access, id);
  }

  @Get('fee-rules')
  @RequirePermission('settings', 'view')
  listFeeRules(
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feeRules.list(user.tenantId as number, false, access);
  }

  @Post('fee-rules')
  @RequirePermission('settings', 'edit')
  createFeeRule(
    @Body() dto: FeeRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feeRules.create(user.tenantId as number, user.id, dto, access);
  }

  @Patch('fee-rules/:id')
  @RequirePermission('settings', 'edit')
  updateFeeRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FeeRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feeRules.update(user.tenantId as number, user.id, id, dto, access);
  }

  @Delete('fee-rules/:id')
  @RequirePermission('settings', 'edit')
  removeFeeRule(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.feeRules.remove(user.tenantId as number, id, access);
  }
}
