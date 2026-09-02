import {
  Body,
  Controller,
  Delete,
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
import {
  CreateOwnerDto,
  ImportOwnersDto,
  ListOwnersQueryDto,
  UpdateOwnerDto,
} from './dto';
import { OwnersMgmtService } from './owners-mgmt.service';

/**
 * 业主档案管理（后台「业主用户」页），纯管理端接口，走页面权限矩阵。
 *
 * 页面权限收两个 key：档案 2026-08-24 从「房产与业主」搬到「业主用户」页，
 * 老角色矩阵里只勾了 properties 的照样能用，不用挨个租户去补勾。
 */
@Controller('owners-mgmt')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OwnersMgmtController {
  constructor(private readonly ownersMgmtService: OwnersMgmtService) {}

  @Get()
  @RequirePermission(['owners', 'properties'], 'view')
  list(
    @Query() query: ListOwnersQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersMgmtService.list(query, user, access);
  }

  @Post()
  @RequirePermission(['owners', 'properties'], 'edit')
  create(
    @Body() dto: CreateOwnerDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersMgmtService.create(dto, user, access);
  }

  /**
   * 业主档案批量导入（老系统迁移用），按 legacyRef 幂等。
   * 放在 :id 路由之前，否则 'import' 会被当成 id 走进 PATCH/DELETE 的匹配。
   */
  @Post('import')
  @RequirePermission(['owners', 'properties'], 'edit')
  importOwners(
    @Body() dto: ImportOwnersDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersMgmtService.importOwners(dto, user, access);
  }

  @Patch(':id')
  @RequirePermission(['owners', 'properties'], 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOwnerDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersMgmtService.update(id, dto, user, access);
  }

  @Delete(':id')
  @RequirePermission(['owners', 'properties'], 'delete')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersMgmtService.remove(id, user, access);
  }
}
