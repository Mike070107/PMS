import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ADMIN_PAGE_KEYS } from '../../common/pages';

export class TenantAdminDto {
  @IsString()
  @MaxLength(60)
  name: string;

  @IsString()
  @MinLength(3)
  @MaxLength(60)
  account: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

export class CreateTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  /** 不传 = 全部页面可用 */
  @IsOptional()
  @IsArray()
  @IsIn([...ADMIN_PAGE_KEYS], { each: true })
  enabledPages?: string[];

  /** 服务有效期至（YYYY-MM-DD，含当天）。不传 = 永久 */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '有效期格式应为 YYYY-MM-DD' })
  expiresAt?: string | null;

  /** 首个企业超级管理员账号 */
  @ValidateNested()
  @Type(() => TenantAdminDto)
  admin: TenantAdminDto;
}

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  /** 传 null 表示恢复全部页面可用 */
  @IsOptional()
  @IsArray()
  @IsIn([...ADMIN_PAGE_KEYS], { each: true })
  enabledPages?: string[] | null;

  /** 传 null 表示改回永久 */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '有效期格式应为 YYYY-MM-DD' })
  expiresAt?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ResetTenantAdminDto {
  @IsInt()
  @Type(() => Number)
  userId: number;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  password: string;
}
