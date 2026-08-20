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
import { PermissionsGuard } from '../access/permissions.guard';
import { SaveOfficeDto } from './dto';
import { OfficesService } from './offices.service';

@Controller('offices')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OfficesController {
  constructor(private readonly officesService: OfficesService) {}

  @Get()
  @RequirePermission('offices', 'view')
  list(@CurrentUser() user: AuthUser) {
    return this.officesService.list(user);
  }

  @Post()
  @RequirePermission('offices', 'edit')
  create(@Body() dto: SaveOfficeDto, @CurrentUser() user: AuthUser) {
    return this.officesService.create(dto, user);
  }

  @Patch(':id')
  @RequirePermission('offices', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveOfficeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.officesService.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermission('offices', 'delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.officesService.remove(id, user);
  }
}
