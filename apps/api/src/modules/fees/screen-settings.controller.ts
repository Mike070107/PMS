import { Body, BadRequestException, ForbiddenException, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CollectionTargetsService } from './collection-targets.service';
import { ScreenSettingsService } from './screen-settings.service';
import { SaveScreenSettingsDto } from './screen-settings.dto';
import { ScreenSummaryQueryDto, UpsertCollectionTargetDto } from './collection-targets.dto';
@Controller('fees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ScreenSettingsController {
  constructor(private readonly screenSettingsService: ScreenSettingsService, private readonly collectionTargetsService: CollectionTargetsService) {}
  @Get('screen-settings')
  @RequirePermission('fees','view')
  screenSettings(@Query() query:ScreenSummaryQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){
    return this.screenSettingsService.read(user,access,query.year??Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Shanghai'}).format(new Date())),query.communityIds);
  }

  @Put('screen-settings')
  @RequirePermission('fees','edit')
  saveScreenSettings(@Body() dto:SaveScreenSettingsDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.screenSettingsService.save(user,access,dto);}

  @Put('screen-targets')
  @RequirePermission('fees','edit')
  async saveScreenTarget(@Body() dto:UpsertCollectionTargetDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){
    const allowed=await this.screenSettingsService.scope(user,access);
    if(dto.communityIds.some(id=>!allowed.some(row=>Number(row.id)===id)))throw new ForbiddenException('目标包含范围外小区');
    if(dto.annualCents>1000000000000||dto.monthCents?.some(value=>value!==null&&value>1000000000000))throw new BadRequestException('目标金额超出支持范围');
    if(!dto.monthCents||dto.monthCents.length!==12||dto.monthCents.some(value=>value===null)||dto.monthCents.reduce<number>((a,b)=>a+(b||0),0)!==dto.annualCents)throw new BadRequestException('请填写12个月计划，合计必须等于年度目标');
    return this.collectionTargetsService.upsert(Number(user.tenantId),user.id,dto);
  }

}
