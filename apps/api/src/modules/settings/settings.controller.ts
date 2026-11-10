import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { DispatchNoticeRecipientsDto, UpdateTenantSettingsDto } from './dto';
import { AccessService } from '../access/access.service';
import { SettingsService } from './settings.service';
import { CollectionSmsService, CollectionSmsConfigDto } from './collection-sms.service';
import { NoticeTemplateService, type NoticeTemplate } from './notice-template.service';
import { CollectionFollowupService, type FollowupRule } from './collection-followup.service';

@Controller('settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService, private readonly collectionSms: CollectionSmsService, private readonly noticeTemplate: NoticeTemplateService, private readonly collectionFollowup: CollectionFollowupService, private readonly accessService: AccessService) {}

  @Get('dispatch-recipients/offices')
  @RequirePermission('settings', 'view')
  listDispatchNoticeOffices(@CurrentUser() user: AuthUser) {
    return this.accessService.listVisibleOffices(user);
  }

  private async dispatchNoticeOptions(user: AuthUser, officeId: number) {
    if (!user.tenantId) throw new ForbiddenException('请先选择公司');
    const offices = await this.accessService.listVisibleOffices(user);
    if (!offices.some((office) => office.id === officeId)) throw new ForbiddenException('管理处不在你的工作范围内');
    const [app, web] = await Promise.all([
      this.accessService.userIdsWithPermission(user.tenantId, 'app:dispatch', 'edit'),
      this.accessService.userIdsWithPermission(user.tenantId, 'work-orders', 'edit'),
    ]);
    const ids = [...new Set([...app, ...web])];
    const coverage = await this.accessService.filterUsersCoveringOffice(user.tenantId, ids, officeId);
    const users = await this.settingsService.dispatchNoticeUsers(user.tenantId, ids.filter((id) => coverage.has(id)));
    const selected = await this.settingsService.getDispatchNoticeRecipients(user.tenantId, officeId);
    return { officeId, users, selected };
  }

  @Get('dispatch-recipients/:officeId')
  @RequirePermission('settings', 'view')
  getDispatchNoticeRecipients(@Param('officeId', ParseIntPipe) officeId: number, @CurrentUser() user: AuthUser) {
    return this.dispatchNoticeOptions(user, officeId);
  }

  @Patch('dispatch-recipients')
  @RequirePermission('settings', 'edit')
  async saveDispatchNoticeRecipients(@Body() dto: DispatchNoticeRecipientsDto, @CurrentUser() user: AuthUser) {
    const options = await this.dispatchNoticeOptions(user, dto.officeId);
    const allowed = new Set(options.users.map((candidate) => candidate.id));
    if (dto.userIds.some((id) => !allowed.has(id))) throw new BadRequestException('所选人员必须在职、有派单权限且覆盖该管理处');
    await this.settingsService.saveDispatchNoticeRecipients(user.tenantId!, dto.officeId, dto.userIds, user.id);
    return this.dispatchNoticeOptions(user, dto.officeId);
  }

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
