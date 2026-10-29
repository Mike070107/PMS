import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateIntakeInput, ReviewIntakeInput, VehicleIntakeService } from './vehicle-intake.service';

const VIEW = ['business', 'family-cars'] as const;

/** 新办车牌 / 亲情车扫码登记（办公室端） */
@Controller('vehicle-intakes')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class VehicleIntakeController {
  constructor(private readonly service: VehicleIntakeService) {}

  @Get()
  @RequirePermission([...VIEW], 'view')
  list(@Query() query: { status?: string; kind?: string; q?: string; houseId?: string; open?: string }, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.list({ ...query, houseId: query.houseId ? Number(query.houseId) : undefined, open: query.open === '1' }, user, access);
  }

  @Get(':id')
  @RequirePermission([...VIEW], 'view')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.get(id, user, access);
  }

  @Post()
  @RequirePermission([...VIEW], 'edit')
  create(@Body() body: CreateIntakeInput, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.create(body, user, access);
  }

  @Post(':id/show-qr')
  @RequirePermission([...VIEW], 'view')
  showQr(@Param('id', ParseIntPipe) id: number, @Body() body: { formBase: string }, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.showQr(id, body?.formBase, user, access);
  }

  @Post(':id/qr')
  @RequirePermission([...VIEW], 'edit')
  regenerate(@Param('id', ParseIntPipe) id: number, @Body() body: { formBase: string }, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.regenerate(id, body?.formBase, user, access);
  }

  @Post(':id/class')
  @RequirePermission([...VIEW], 'edit')
  setClass(@Param('id', ParseIntPipe) id: number, @Body() body: { vehicleClass: string }, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.setClass(id, body?.vehicleClass ?? '', user, access);
  }

  @Post(':id/garages')
  @RequirePermission([...VIEW], 'edit')
  setGarages(@Param('id', ParseIntPipe) id: number, @Body() body: { garages?: string[]; garageNumbers?: Record<string, string> }, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.setGarages(id, body?.garages, body?.garageNumbers, user, access);
  }

  @Post(':id/review')
  @RequirePermission([...VIEW], 'edit')
  review(@Param('id', ParseIntPipe) id: number, @Body() body: ReviewIntakeInput, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.review(id, body, user, access);
  }
}

/** 业主手机填写页：不登录，链接里的随机码是唯一凭据（1 小时有效） */
@Controller('vehicle-intake-form')
export class VehicleIntakeFormController {
  constructor(private readonly service: VehicleIntakeService) {}

  @Get(':token')
  session(@Param('token') token: string) {
    return this.service.publicSession(token);
  }

  @Post(':token')
  @UseInterceptors(FilesInterceptor('file', 10, { limits: { fileSize: 20 * 1024 * 1024 } }))
  submit(@Param('token') token: string, @UploadedFiles() files?: Express.Multer.File[], @Body() body?: Record<string, unknown>) {
    return this.service.publicSubmit(token, files, body);
  }
}
