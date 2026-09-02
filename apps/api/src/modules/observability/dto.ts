import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const LOG_CATEGORIES = ['login', 'operation', 'error', 'alert', 'usage'] as const;
export const LOG_LEVELS = ['info', 'warning', 'error'] as const;
export const CLIENT_SOURCES = ['admin-web', 'miniapp-staff', 'miniapp-owner'] as const;

export class SystemLogQueryDto {
  @IsOptional()
  @IsIn(LOG_CATEGORIES)
  category?: (typeof LOG_CATEGORIES)[number];

  @IsOptional()
  @IsIn(LOG_LEVELS)
  level?: (typeof LOG_LEVELS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(30)
  source?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  success?: 'true' | 'false';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  keyword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(100)
  pageSize = 30;
}

export class PageViewDto {
  @IsString()
  @MaxLength(200)
  path: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class ClientErrorDto {
  @IsIn(CLIENT_SOURCES)
  source: (typeof CLIENT_SOURCES)[number];

  @IsString()
  @MaxLength(500)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  version?: string;
}
