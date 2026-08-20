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
import {
  BusinessRuleQueryDto,
  BusinessSearchDto,
  CompleteBusinessDto,
  EstimateBusinessDto,
  UpsertBusinessRuleDto,
} from './dto';
import { BusinessService } from './business.service';

/** 前台收费（纯管理端页面），走页面权限矩阵。 */
@Controller('business')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BusinessController {
  constructor(private readonly businessService: BusinessService) {}

  @Get('rules')
  @RequirePermission('business', 'view')
  listRules(
    @Query() query: BusinessRuleQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.listRules(query, user, access);
  }

  @Post('rules')
  @RequirePermission('business', 'edit')
  createRule(
    @Body() dto: UpsertBusinessRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.createRule(dto, user, access);
  }

  @Patch('rules/:id')
  @RequirePermission('business', 'edit')
  updateRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertBusinessRuleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.updateRule(id, dto, user, access);
  }

  @Get('search')
  @RequirePermission('business', 'view')
  search(
    @Query() query: BusinessSearchDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.search(query, user, access);
  }

  @Post('estimate')
  @RequirePermission('business', 'view')
  estimate(@Body() dto: EstimateBusinessDto, @CurrentUser() user: AuthUser) {
    return this.businessService.estimate(dto, user);
  }

  @Post('complete')
  @RequirePermission('business', 'edit')
  complete(
    @Body() dto: CompleteBusinessDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.businessService.complete(dto, user, access);
  }

  @Get('transactions')
  @RequirePermission('business', 'view')
  listTransactions(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.businessService.listTransactions(user, access);
  }
}
