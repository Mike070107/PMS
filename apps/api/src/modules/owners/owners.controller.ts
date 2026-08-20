import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
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
  ApproveAuditDto,
  ListAuditsQueryDto,
  RegisterOwnerDto,
  RejectAuditDto,
} from './dto';
import { OwnersService } from './owners.service';

@Controller()
export class OwnersController {
  constructor(private readonly ownersService: OwnersService) {}

  @Post('owners/register')
  register(@Body() dto: RegisterOwnerDto) {
    return this.ownersService.register(dto);
  }

  /** 工作台的「待审业主」角标也读这里，所以查看权取两页任一 */
  @Get('audits')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission(['owners', 'dashboard'], 'view')
  listAudits(
    @Query() query: ListAuditsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersService.listAudits(query, user, access);
  }

  @Post('audits/:id/approve')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('owners', 'edit')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveAuditDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersService.approve(id, dto, user, access);
  }

  @Post('audits/:id/reject')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('owners', 'edit')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectAuditDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.ownersService.reject(id, dto, user, access);
  }
}
