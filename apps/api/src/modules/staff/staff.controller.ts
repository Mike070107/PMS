import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { CreateStaffDto, ListStaffQueryDto, UpdateStaffDto } from './dto';
import { StaffService } from './staff.service';

/**
 * 用户管理（原员工管理）。改挂页面级权限：由后台角色矩阵决定，
 * 业务身份不再限制谁能进（受限操作者的可操作范围在 service 里校验）。
 */
@Controller('staff')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @RequirePermission('users', 'view')
  list(
    @Query() query: ListStaffQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.staffService.list(query, user, access);
  }

  @Post()
  @RequirePermission('users', 'edit')
  create(
    @Body() dto: CreateStaffDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.staffService.create(dto, user, access);
  }

  @Post(':id/unbind-wx')
  @RequirePermission('users', 'edit')
  unbindWx(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.staffService.unbindWx(id, user, access);
  }

  @Patch(':id')
  @RequirePermission('users', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStaffDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.staffService.update(id, dto, user, access);
  }
}
