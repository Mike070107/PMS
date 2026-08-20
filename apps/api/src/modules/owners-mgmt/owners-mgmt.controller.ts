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
import { CreateOwnerDto, ListOwnersQueryDto, UpdateOwnerDto } from './dto';
import { OwnersMgmtService } from './owners-mgmt.service';

/** 业主档案管理（后台「房产与业主」页），纯管理端接口，走页面权限矩阵。 */
@Controller('owners-mgmt')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OwnersMgmtController {
  constructor(private readonly ownersMgmtService: OwnersMgmtService) {}

  @Get()
  @RequirePermission('properties', 'view')
  list(
    @Query() query: ListOwnersQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersMgmtService.list(query, user, access);
  }

  @Post()
  @RequirePermission('properties', 'edit')
  create(@Body() dto: CreateOwnerDto, @CurrentUser() user: AuthUser) {
    return this.ownersMgmtService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('properties', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOwnerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ownersMgmtService.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermission('properties', 'delete')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.ownersMgmtService.remove(id, user);
  }
}
