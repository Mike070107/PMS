import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { LlmService } from './llm.service';

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

@Controller('settings/ai')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AiController {
  constructor(private readonly llm: LlmService) {}

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
}
