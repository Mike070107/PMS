import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { QrGranularity } from '../../common/enums';

/** query 里的 boolean 是字符串，'true'/'1' 都当真 */
const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

export class CreateQrCodeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsEnum(QrGranularity)
  granularity: QrGranularity;

  @Type(() => Number)
  @IsInt()
  communityId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  placeNote?: string;
}

export class BuildingQrQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}

export class BackfillBuildingQrDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  /** 只补某个小区，不传则全租户 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  /** 单次生成张数上限，前端循环调用直到 remaining = 0 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** 连已有图的也重画（换落地页 / 换小程序版本时用） */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  force?: boolean;
}

export class RegenerateQrDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  ids?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  buildingIds?: number[];

  /** 顺带按当前小区/楼栋名重算印刷文案 */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  refreshCaption?: boolean;
}
