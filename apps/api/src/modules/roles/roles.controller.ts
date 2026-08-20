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
import { SaveRoleDto } from './dto';
import { RolesService } from './roles.service';

@Controller('roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermission('roles', 'view')
  list(@CurrentUser() user: AuthUser) {
    return this.rolesService.list(user);
  }

  @Get('scope-options')
  @RequirePermission('roles', 'view')
  scopeOptions(@CurrentUser() user: AuthUser) {
    return this.rolesService.scopeOptions(user);
  }

  /** 用户管理页的角色下拉：按操作者范围裁剪，所以挂在 users 的查看权下 */
  @Get('assignable')
  @RequirePermission('users', 'view')
  assignable(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.rolesService.assignable(user, access);
  }

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
