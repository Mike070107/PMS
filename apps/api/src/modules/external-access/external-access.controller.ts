import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { CreateExternalAccessAppDto, UpdateExternalAccessAppDto } from './dto';
import { ExternalAccessService } from './external-access.service';

@Controller('external-access')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExternalAccessController {
  constructor(private readonly service: ExternalAccessService) {}

  @Get('apps')
  @RequirePermission('settings', 'view')
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user);
  }

  @Get('config')
  @RequirePermission('settings', 'view')
  configuration() {
    return this.service.configuration();
  }

  @Get('users')
  @RequirePermission('settings', 'view')
  users(@CurrentUser() user: AuthUser) {
    return this.service.users(user);
  }

  @Post('apps')
  @RequirePermission('settings', 'edit')
  create(@Body() dto: CreateExternalAccessAppDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('apps/:id')
  @RequirePermission('settings', 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateExternalAccessAppDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post('apps/:id/sync')
  @RequirePermission('settings', 'edit')
  sync(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.sync(id, user);
  }
}
