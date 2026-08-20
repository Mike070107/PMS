import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { UpdateTenantSettingsDto } from './dto';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /** 读设置：报修录入等页面也要读（决定录入页怎么显示），查看权取任一相关页面 */
  @Get()
  @RequirePermission(['settings', 'work-orders'], 'view')
  getSettings(@CurrentUser() user: AuthUser) {
    return this.settingsService.getSettings(user);
  }

  /** 现在到底有多少业主能被手机号匹配到——开关开了却匹配不到人是最常见的困惑 */
  @Get('phone-match-stat')
  @RequirePermission('settings', 'view')
  getPhoneMatchStat(@CurrentUser() user: AuthUser) {
    return this.settingsService.getPhoneMatchStat(user);
  }

  @Patch()
  @RequirePermission('settings', 'edit')
  updateSettings(
    @Body() dto: UpdateTenantSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.settingsService.updateSettings(dto, user);
  }
}
