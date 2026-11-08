import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListCollectionTargetsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

export class UpsertCollectionTargetDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  @Min(1, { each: true })
  communityIds: number[];

  @IsOptional()
  @IsIn(['property', 'berth', 'parking', 'other'])
  feeCode?: 'property' | 'berth' | 'parking' | 'other';

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  annualCents: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsInt({ each: true })
  @Min(0, { each: true })
  monthCents?: (number | null)[];
}

export class ScreenSummaryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsIn(['day', 'month'])
  granularity?: 'day' | 'month';

  /** 逗号分隔小区 ID；不传 = 全部授权小区。 */
  @IsOptional()
  @IsString()
  communityIds?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;
}
