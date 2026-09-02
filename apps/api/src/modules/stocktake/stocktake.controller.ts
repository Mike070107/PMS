import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import {
  CreateStocktakeDto,
  ReviewStocktakeDto,
  SaveStocktakeItemDto,
  StocktakeQueryDto,
} from './dto';
import { StocktakeService } from './stocktake.service';

@Controller('stocktakes')
@UseGuards(JwtAuthGuard, RolesOrPermissionGuard)
export class StocktakeController {
  constructor(private readonly service: StocktakeService) {}

  @Get()
  @RequirePermission(['stocktakes', 'app:stocktakes'], 'view')
  list(
    @Query() query: StocktakeQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.list(query, user, access);
  }

  @Post()
  @RequirePermission(['stocktakes', 'app:stocktakes'], 'edit')
  create(
    @Body() dto: CreateStocktakeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.create(dto, user, access);
  }

  @Get(':id')
  @RequirePermission(['stocktakes', 'app:stocktakes'], 'view')
  detail(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.detail(id, user, access);
  }

  /** 小程序统一走 POST，避免部分基础库对 PATCH 的兼容差异。 */
  @Post(':id/items/:itemId/count')
  @RequirePermission(['stocktakes', 'app:stocktakes'], 'edit')
  count(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: SaveStocktakeItemDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.saveItem(id, itemId, dto, user, access);
  }

  @Post(':id/submit')
  @RequirePermission(['stocktakes', 'app:stocktakes'], 'edit')
  submit(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.submit(id, user, access);
  }

  @Post(':id/review')
  @RequirePermission(['stocktakes', 'app:stocktakes'], 'edit')
  review(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewStocktakeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.review(id, dto, user, access);
  }
}
