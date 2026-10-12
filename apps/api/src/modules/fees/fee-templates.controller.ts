import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { FeeTemplatesService } from './fee-templates.service';
import { AssignTemplateDto, LegacyTemplateImportDto, SaveTemplateDto, TemplateListDto, TemplateScopeDto } from './fee-templates.dto';

@Controller('fees/templates')
@UseGuards(JwtAuthGuard,PermissionsGuard)
export class FeeTemplatesController {
  constructor(private readonly service:FeeTemplatesService) {}
  @Get('communities') @RequirePermission('settings','view')
  communities(@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.communities(user,access); }
  @Get() @RequirePermission('settings','view')
  list(@Query() dto:TemplateScopeDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.list(dto,user,access); }
  @Get('houses') @RequirePermission('settings','view')
  houses(@Query() dto:TemplateListDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.houses(dto,user,access); }
  @Get('legacy-preview') @RequirePermission('settings','view')
  preview(@Query() dto:TemplateScopeDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.legacyPreview(dto,user,access); }
  @Post('legacy-import') @RequirePermission('settings','edit')
  migrate(@Body() dto:LegacyTemplateImportDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.importLegacy(dto,user,access); }
  @Post('assign') @RequirePermission('settings','edit')
  assign(@Body() dto:AssignTemplateDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.assign(dto,user,access); }
  @Post() @RequirePermission('settings','edit')
  create(@Body() dto:SaveTemplateDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.save(dto,user,access); }
  @Patch(':id') @RequirePermission('settings','edit')
  update(@Param('id',ParseIntPipe) id:number,@Body() dto:SaveTemplateDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.save(dto,user,access,id); }
  @Post(':id/disable') @RequirePermission('settings','edit')
  disable(@Param('id',ParseIntPipe) id:number,@Body() dto:TemplateScopeDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess) { return this.service.disable(id,dto,user,access); }
}
