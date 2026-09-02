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
import { SaveOfficeDto } from './dto';
import { OfficesService } from './offices.service';

@Controller('offices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OfficesController {
  constructor(private readonly officesService: OfficesService) {}

  @Get()
  @RequirePermission('offices', 'view')
  list(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.officesService.list(user, access);
  }

  @Post()
  @RequirePermission('offices', 'edit')
  create(
    @Body() dto: SaveOfficeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.officesService.create(dto, user, access);
  }

  @Patch(':id')
  @RequirePermission('offices', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveOfficeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.officesService.update(id, dto, user, access);
  }

  @Delete(':id')
  @RequirePermission('offices', 'delete')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.officesService.remove(id, user, access);
  }
}
