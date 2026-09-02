import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { SaveAsTemplateDto, SaveRoleDto, SaveRoleTemplateDto } from './dto';
import { RolesService } from './roles.service';

@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermission('roles', 'view')
  list(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.rolesService.list(user, access);
  }

  @Get('scope-options')
  @RequirePermission('roles', 'view')
  scopeOptions(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.rolesService.scopeOptions(user, access);
  }

  /** 用户管理页的角色下拉：按操作者范围裁剪，所以挂在 users 的查看权下 */
  @Get('assignable')
  @RequirePermission('users', 'view')
  assignable(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.rolesService.assignable(user, access);
  }

  // ---------------- 权限模板 ----------------
  // 注意路由顺序：'templates' 必须写在 ':id' 之前，否则会被当成一个 id 走进角色详情。

  @Get('templates')
  @RequirePermission('roles', 'view')
  listTemplates(@CurrentUser() user: AuthUser) {
    return this.rolesService.listTemplates(user);
  }

  @Post('templates')
  @RequirePermission('roles', 'edit')
  createTemplate(
    @Body() dto: SaveRoleTemplateDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.createTemplate(dto, user, access);
  }

  /** 把代码里那几个开箱模板导成可编辑的模板行；同名的跳过 */
  @Post('templates/import-built-in')
  @RequirePermission('roles', 'edit')
  importBuiltInTemplates(
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.importBuiltInTemplates(user, access);
  }

  @Patch('templates/:id')
  @RequirePermission('roles', 'edit')
  updateTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveRoleTemplateDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.updateTemplate(id, dto, user, access);
  }

  @Delete('templates/:id')
  @RequirePermission('roles', 'delete')
  removeTemplate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.removeTemplate(id, user, access);
  }

  /** 把这个角色当前的勾选另存为模板，并让它改成跟随（权限不变） */
  @Post(':id/save-as-template')
  @RequirePermission('roles', 'edit')
  saveAsTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveAsTemplateDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.saveRoleAsTemplate(id, dto, user, access);
  }

  // ---------------- 角色 ----------------

  @Post()
  @RequirePermission('roles', 'edit')
  create(
    @Body() dto: SaveRoleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.create(dto, user, access);
  }

  @Patch(':id')
  @RequirePermission('roles', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveRoleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.update(id, dto, user, access);
  }

  @Delete(':id')
  @RequirePermission('roles', 'delete')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.rolesService.remove(id, user, access);
  }
}
