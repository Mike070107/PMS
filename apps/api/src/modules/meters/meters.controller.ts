import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AdjustChargeDto,
  ChargeQueryDto,
  CreateMeterDto,
  CreateReadingDto,
  MeterQueryDto,
  MeterSummaryQueryDto,
  OcrQueryDto,
  OcrSampleQueryDto,
  PayChargeDto,
  ReadingQueryDto,
  ReviewReadingDto,
  UpdateMeterDto,
  UpdateOcrSampleDto,
  UpdateReadingDto,
} from './dto';
import { MetersService } from './meters.service';

/**
 * 抄表模块。后台和员工端共用同一批接口，权限矩阵里分别挂 `meters` / `app:meters`。
 *
 * 需要特别注意的两类动作：
 * - 员工端只需要「看档案 + 拍照提交读数」，**不能改档案、不能收款**；
 * - 修正/作废历史读数、账单收款、调整应收，一律只给后台 `meters` 页权限。
 */
@Controller('meters')
@UseGuards(JwtAuthGuard, RolesOrPermissionGuard)
export class MetersController {
  constructor(private readonly service: MetersService) {}

  // ------------------------------------------------------------ 静态路径先声明

  @Get()
  @RequirePermission(['meters', 'app:meters'], 'view')
  list(
    @Query() query: MeterQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.listMeters(query, user, access);
  }

  @Get('summary')
  @RequirePermission(['meters', 'app:meters'], 'view')
  summary(
    @Query() query: MeterSummaryQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.summary(query, user, access);
  }

  /** 扫码：支持 PMS-METER 二维码原文、裸 token、表号 */
  @Get('lookup')
  @RequirePermission(['meters', 'app:meters'], 'view')
  lookup(
    @Query('code') code: string,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.lookup(code, user, access);
  }

  @Get('readings')
  @RequirePermission(['meters', 'app:meters'], 'view')
  readings(
    @Query() query: ReadingQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.listReadings(query, user, access);
  }

  @Post('readings/:id/review')
  @RequirePermission(['meters', 'app:meters'], 'edit')
  reviewReading(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewReadingDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.reviewReading(id, dto, user, access);
  }

  @Get('readings/:id')
  @RequirePermission(['meters', 'app:meters'], 'view')
  reading(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.readingDetail(id, user, access);
  }

  @Put('readings/:id')
  @RequirePermission(['meters', 'app:meters'], 'edit')
  updateReading(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateReadingDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.updateReading(id, dto, user, access);
  }

  @Get('charges')
  @RequirePermission(['meters', 'app:meters'], 'view')
  charges(
    @Query() query: ChargeQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.listCharges(query, user, access);
  }

  @Post('charges/:id/pay')
  @RequirePermission('meters', 'edit')
  pay(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PayChargeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.payCharge(id, dto, user, access);
  }

  @Post('charges/:id/adjust')
  @RequirePermission('meters', 'edit')
  adjust(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdjustChargeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.adjustCharge(id, dto, user, access);
  }

  @Post('charges/:id/void')
  @RequirePermission('meters', 'delete')
  voidCharge(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.voidCharge(id, user, access);
  }

  @Get('ocr/health')
  @RequirePermission('meters', 'view')
  ocrHealth() {
    return this.service.ocrHealth();
  }

  @Get('ocr-samples')
  @RequirePermission('meters', 'view')
  ocrSamples(
    @Query() query: OcrSampleQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.listOcrSamples(query, user, access);
  }

  @Patch('ocr-samples/:id')
  @RequirePermission('meters', 'edit')
  updateOcrSample(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOcrSampleDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.updateOcrSample(id, dto, user, access);
  }

  // ------------------------------------------------------------ 档案

  @Post()
  @RequirePermission('meters', 'edit')
  create(
    @Body() dto: CreateMeterDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.createMeter(dto, user, access);
  }

  @Get(':id')
  @RequirePermission(['meters', 'app:meters'], 'view')
  detail(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.meterDetail(id, user, access);
  }

  @Put(':id')
  @RequirePermission(['meters', 'app:meters'], 'edit')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMeterDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.updateMeter(id, dto, user, access);
  }

  @Delete(':id')
  @RequirePermission('meters', 'delete')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.deleteMeter(id, user, access);
  }

  @Get(':id/qr')
  @RequirePermission(['meters', 'app:meters'], 'view')
  qr(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.qrCode(id, user, access);
  }

  @Post(':id/ocr')
  @RequirePermission([['meters', 'edit'], ['app:meters', 'edit']], 'view')
  ocr(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OcrQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.recognize(id, dto, user, access);
  }

  @Post(':id/readings')
  @RequirePermission([['meters', 'edit'], ['app:meters', 'edit']], 'view')
  createReading(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateReadingDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.service.createReading(id, dto, user, access);
  }
}
