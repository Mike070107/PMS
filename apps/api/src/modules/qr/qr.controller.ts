import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../../common/require-permission.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import {
  BackfillBuildingQrDto,
  BuildingQrQueryDto,
  CreateQrCodeDto,
  RegenerateQrDto,
} from './dto';
import { QrService } from './qr.service';

@Controller()
export class QrController {
  constructor(private readonly qrService: QrService) {}

  /** 楼栋码总览：每个楼栋一行，含码与生成状态（后台打印页的数据源） */
  @Get('qr-codes/buildings')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('qr', 'view')
  listBuildingCodes(
    @Query() query: BuildingQrQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.qrService.listBuildingCodes(query, user, access);
  }

  @Post('qr-codes')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('qr', 'edit')
  create(@Body() dto: CreateQrCodeDto, @CurrentUser() user: AuthUser) {
    return this.qrService.create(dto, user);
  }

  /** 给存量楼栋批量补码，分批返回 remaining，前端循环调用显示进度 */
  @Post('qr-codes/backfill-buildings')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('qr', 'edit')
  backfillBuildings(
    @Body() dto: BackfillBuildingQrDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.qrService.backfillBuildings(dto, user);
  }

  @Post('qr-codes/regenerate')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermission('qr', 'edit')
  regenerate(@Body() dto: RegenerateQrDto, @CurrentUser() user: AuthUser) {
    return this.qrService.regenerate(dto, user);
  }

  /** 公开：扫码后未登录也要能拿到位置信息 */
  @Get('qr/:token')
  resolve(@Param('token') token: string) {
    return this.qrService.resolve(token);
  }
}
