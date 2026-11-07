import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class PageViewItemDto {
  @IsString()
  @MaxLength(300)
  path: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  pageKey?: string;

  /** 客户端时间只作参考；偏差超过 5 分钟由服务端改用服务器时间。 */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  at?: string;
}

export class PageViewsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PageViewItemDto)
  views: PageViewItemDto[];
}

export class PageUsageQueryDto {
  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '开始日期不合法' })
  from: string;

  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '结束日期不合法' })
  to: string;

  /** 预留：page_views 当前是租户级，不按小区过滤。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  communityId?: number;
}

export class LoginHistoryQueryDto {
  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '开始日期不合法' })
  from: string;

  @IsDefined()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '结束日期不合法' })
  to: string;

  @IsOptional()
  @IsIn(['all', 'success', 'failed'])
  status?: 'all' | 'success' | 'failed';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
