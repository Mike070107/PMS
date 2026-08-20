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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateTenantDto, ResetTenantAdminDto, UpdateTenantDto } from './dto';
import { PlatformGuard } from './platform.guard';
import { PlatformService } from './platform.service';

@Controller('platform')
@UseGuards(JwtAuthGuard, PlatformGuard)
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Get('tenants')
  listTenants() {
    return this.platformService.listTenants();
  }

  @Post('tenants')
  createTenant(@Body() dto: CreateTenantDto, @CurrentUser() user: AuthUser) {
    return this.platformService.createTenant(dto, user);
  }

  @Patch('tenants/:id')
  updateTenant(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTenantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.platformService.updateTenant(id, dto, user);
  }

  @Post('tenants/:id/reset-admin-password')
  resetAdminPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetTenantAdminDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.platformService.resetAdminPassword(id, dto, user);
  }

  @Post('tenants/:id/enter')
  enterTenant(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.platformService.enterTenant(id, user);
  }

  @Post('tenants/:id/exit')
  exitTenant(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.platformService.exitTenant(id, user);
  }

  @Get('logs')
  listLogs(@Query('tenantId') tenantId?: string) {
    const parsed = tenantId ? Number(tenantId) : undefined;
    return this.platformService.listLogs(
      Number.isInteger(parsed) && parsed! > 0 ? parsed : undefined,
    );
  }
}
