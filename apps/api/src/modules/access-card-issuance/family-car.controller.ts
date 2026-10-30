import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { PermissionsGuard } from '../access/permissions.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FamilyCarService } from './family-car.service';

export class CreateFamilyCarDto {
  @Type(() => Number) @IsInt() houseId: number;
  @IsString() @MinLength(7) @MaxLength(20) plate: string;
  @Type(() => Number) @IsInt() duplicateCheckQueryId: number;
  @IsOptional() @IsBoolean() ownerFill?: boolean;
  @IsOptional() @IsString() @MaxLength(50) carOwnerName?: string;
  @IsOptional() @IsString() @MaxLength(30) carOwnerPhone?: string;
  @IsOptional() @IsString() @MaxLength(20) relation?: string;
  @IsOptional() @IsString() @MaxLength(200) remark?: string;
  @IsArray() @IsString({ each: true }) garages: string[];
  @IsOptional() @IsObject() garageNumbers?: Record<string, string>;
  @IsOptional() @Type(() => Number) @IsInt() previousId?: number;
}

export class UpdateFamilyCarDto {
  @IsOptional() @IsString() @MaxLength(50) carOwnerName?: string;
  @IsOptional() @IsString() @MaxLength(30) carOwnerPhone?: string;
  @IsOptional() @IsString() @MaxLength(20) relation?: string;
  @IsOptional() @IsString() @MaxLength(200) remark?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) garages?: string[];
  @IsOptional() @IsObject() garageNumbers?: Record<string, string>;
}

export class OfficeReviewFamilyCarDto {
  @IsIn(['approve', 'reupload', 'void']) decision: 'approve' | 'reupload' | 'void';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ManagerReviewFamilyCarDto {
  @IsIn(['approve', 'return']) decision: 'approve' | 'return';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class StopFamilyCarDto {
  @IsString() @MinLength(1) @MaxLength(200) note: string;
}

/** 从停车系统导入的一行：现场把旧库的亲情车清单导成表，按行贴进来 */
export class ImportFamilyCarRowDto {
  @IsString() @MinLength(6) @MaxLength(20) plate: string;
  /** 房号，支持 228/6/502、228弄6号502室、6/502 */
  @IsString() @MinLength(3) @MaxLength(40) room: string;
  @IsOptional() @IsString() @MaxLength(50) ownerName?: string;
  @IsOptional() @IsString() @MaxLength(30) ownerPhone?: string;
  @IsOptional() @IsString() @MaxLength(50) carOwnerName?: string;
  @IsOptional() @IsString() @MaxLength(30) carOwnerPhone?: string;
  @IsOptional() @IsString() @MaxLength(20) relation?: string;
  /** 旧库车辆身份（Car_Brand）。给了就必须是「亲情车」，防止把住户车导进来 */
  @IsOptional() @IsString() @MaxLength(30) identity?: string;
  @IsOptional() @IsString() @MaxLength(20) database?: string;
  @IsOptional() @IsString() @MaxLength(20) startDate?: string;
  @IsOptional() @IsString() @MaxLength(20) endDate?: string;
  @IsOptional() @IsString() @MaxLength(200) remark?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) garages?: string[];
}

export class ImportFamilyCarsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ImportFamilyCarRowDto) rows: ImportFamilyCarRowDto[];
  /** true = 只出核对结果，不落库 */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

const MANAGER = ['family-cars-approve', 'app:family-car-approve'] as const;

/** 亲情车管理：清册、登记、资料、办公室审核、物业经理审核、开通、停用 */
@Controller('family-cars')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FamilyCarController {
  constructor(private readonly service: FamilyCarService) {}

  @Get()
  @RequirePermission(['family-cars', ...MANAGER], 'view')
  list(@Query() query: { status?: string; lane?: string; q?: string }, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.list(query, user, access);
  }

  @Get('pending-manager')
  @RequirePermission([...MANAGER], 'view')
  pendingManager(@CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.pendingManager(user, access);
  }

  @Get('houses/:houseId')
  @RequirePermission('family-cars', 'view')
  houseContext(@Param('houseId', ParseIntPipe) houseId: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.houseContext(houseId, user, access);
  }

  @Get(':id')
  @RequirePermission(['family-cars', ...MANAGER], 'view')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.get(id, user, access);
  }

  @Post()
  @RequirePermission('family-cars', 'edit')
  create(@Body() dto: CreateFamilyCarDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.create(dto, user, access);
  }

  @Post('legacy-pull')
  @RequirePermission('family-cars', 'edit')
  startLegacyPull(@CurrentUser() user: AuthUser) {
    return this.service.startLegacyPull(user);
  }

  @Get('legacy-pull/:id')
  @RequirePermission('family-cars', 'edit')
  legacyPullResult(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.legacyPullResult(id, user);
  }

  @Post('import')
  @RequirePermission('family-cars', 'edit')
  importFromParking(@Body() dto: ImportFamilyCarsDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.importFromParking(dto, user, access);
  }

  @Patch(':id')
  @RequirePermission('family-cars', 'edit')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFamilyCarDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.update(id, dto, user, access);
  }

  @Post(':id/qr')
  @RequirePermission('family-cars', 'edit')
  regenerateQr(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.regenerateQr(id, user, access);
  }

  @Post(':id/files')
  @RequirePermission('family-cars', 'edit')
  @UseInterceptors(FilesInterceptor('file', 10, { limits: { fileSize: 20 * 1024 * 1024 } }))
  addFiles(@Param('id', ParseIntPipe) id: number, @UploadedFiles() files: Express.Multer.File[], @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.addFiles(id, files, user, access);
  }

  @Delete(':id/files/:index')
  @RequirePermission('family-cars', 'edit')
  removeFile(@Param('id', ParseIntPipe) id: number, @Param('index', ParseIntPipe) index: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.removeFile(id, index, user, access);
  }

  @Post(':id/submit')
  @RequirePermission('family-cars', 'edit')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.submit(id, user, access);
  }

  @Post(':id/office-review')
  @RequirePermission('family-cars', 'edit')
  officeReview(@Param('id', ParseIntPipe) id: number, @Body() dto: OfficeReviewFamilyCarDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.officeReview(id, dto.decision, dto.note, user, access);
  }

  @Post(':id/manager-review')
  @RequirePermission([...MANAGER], 'edit')
  managerReview(@Param('id', ParseIntPipe) id: number, @Body() dto: ManagerReviewFamilyCarDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.managerReview(id, dto.decision, dto.note, user, access);
  }

  @Post(':id/retry')
  @RequirePermission(['family-cars', ...MANAGER], 'edit')
  retry(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.retry(id, user, access);
  }

  @Post(':id/stop')
  @RequirePermission('family-cars', 'edit')
  stop(@Param('id', ParseIntPipe) id: number, @Body() dto: StopFamilyCarDto, @CurrentUser() user: AuthUser, @CurrentAccess() access: ResolvedAccess) {
    return this.service.stop(id, dto.note, user, access);
  }
}
