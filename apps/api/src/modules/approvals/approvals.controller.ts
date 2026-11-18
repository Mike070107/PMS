import { Body, Controller, Get, Logger, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { PermissionPageKey, RequirePermission } from '../../common/require-permission.decorator';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from '../notifications/notifications.service';
import { ApprovalsService, CenterQuery } from './approvals.service';

const KEYS: PermissionPageKey[] = ['app:approve-purchase-manager', 'app:approve-manager', 'app:approve-purchaser', 'app:approve-business-manager', 'app:family-car-approve', 'family-cars-approve', 'family-cars', 'business', 'inventory', 'app:inventory', 'stocktakes', 'app:stocktakes', 'app:maintenance-sign', 'app:maintenance-inspect'];
class DecisionDto {
  @IsBoolean() approved: boolean;
  @IsOptional() @IsString() @MaxLength(255) note?: string;
}
@Controller('approval-center')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApprovalsController {
  private readonly logger = new Logger(ApprovalsController.name);
  constructor(private readonly service: ApprovalsService, private readonly notifications: NotificationsService) {}
  @Get()
  @RequirePermission(KEYS, 'view')
  list(@Query() query: CenterQuery, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.list(query, user, access);
  }
  @Post(':category/:id/decision')
  @RequirePermission(KEYS, 'view')
  async decide(@Param('category') category: string, @Param('id', ParseIntPipe) id: number, @Body() body: DecisionDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    // Each category is edit-permission + scope + pending-state checked by the service, not this broad entry gate.
    const result = await this.service.decide(category, id, body.approved, body.note, user, access);
    if (category === 'transfer') {
      // Stock mutation already committed: notification failure must not turn success into a retryable error.
      try { await this.notifications.markReadByRef(user, { transferId: id }); }
      catch (error) { this.logger.warn(`Transfer ${id} approved/returned; marking notification read failed: ${String(error)}`); }
    }
    return result;
  }
}
