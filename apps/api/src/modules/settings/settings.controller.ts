import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { UpdateTenantSettingsDto } from './dto';
import { SettingsService } from './settings.service';
import { CollectionSmsService, CollectionSmsConfigDto } from './collection-sms.service';
import { NoticeTemplateService, type NoticeTemplate } from './notice-template.service';
import { CollectionFollowupService, type FollowupRule } from './collection-followup.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService, private readonly collectionSms: CollectionSmsService, private readonly noticeTemplate: NoticeTemplateService, private readonly collectionFollowup: CollectionFollowupService) {}

  @Get('collection-sms')
  @RequirePermission('settings', 'view')
  getCollectionSms(@CurrentUser() user:AuthUser){return this.collectionSms.get(user);}

  @Patch('collection-sms')
  @RequirePermission('settings', 'edit')
  saveCollectionSms(@Body() dto:CollectionSmsConfigDto,@CurrentUser() user:AuthUser){return this.collectionSms.save(dto,user);}

  /** 打印通知单的抬头、联系方式、银行信息与须知 */
  @Get('notice-template')
  @RequirePermission('settings', 'view')
  getNoticeTemplate(@CurrentUser() user:AuthUser){return this.noticeTemplate.get(user);}

  @Patch('notice-template')
  @RequirePermission('settings', 'edit')
  saveNoticeTemplate(@Body() dto:Partial<NoticeTemplate>,@CurrentUser() user:AuthUser){return this.noticeTemplate.save(dto,user);}

  /** 催收跟进规则：大额门槛与久未联系天数，页面可改 */
  @Get('collection-followup')
  @RequirePermission('settings', 'view')
  getFollowupRule(@CurrentUser() user:AuthUser){return this.collectionFollowup.get(user);}

  @Patch('collection-followup')
  @RequirePermission('settings', 'edit')
  saveFollowupRule(@Body() dto:Partial<FollowupRule>,@CurrentUser() user:AuthUser){return this.collectionFollowup.save(dto,user);}

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
