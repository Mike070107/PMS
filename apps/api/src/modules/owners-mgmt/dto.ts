import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsArray, ValidateNested } from 'class-validator';
import { UserStatus } from '../../common/enums';

export class ListOwnersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  /** 按 姓名 / 电话 / 房号 模糊搜索 */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  unbound?: boolean;
}

export class CreateOwnerDto {
  @IsString()
  @MaxLength(60)
  name: string;

  @IsString()
  @MaxLength(30)
  phone: string;

  /** 绑定的房产 id，可空 = 仅建档暂未绑定 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  /** 固话、第二联系人等手机号之外的联系方式 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contactNote?: string | null;
}

export class UpdateOwnerDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number | null;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contactNote?: string | null;
}

// ---------------- 批量导入 ----------------

/**
 * 业主档案批量导入的一行。房号定位用「小区/弄/号/室」四段文字（与物业费导入同一套规则，
 * 见 common/house-index.ts），匹配不上的行原样退回，不猜。
 */
export class ImportOwnerRowDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  communityName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  lane?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  buildingNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  roomNo?: string;

  @IsString()
  @MaxLength(60)
  name: string;

  /** 11 位手机号；老档案里只有固话/没号码时留空 */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  /** 固话、第二个号码、备注等，原样留档 */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contactNote?: string | null;

  /** 导入来源标识（wjwy:zh:<业主表.ZH_ID>），重跑按它认人，不建重 */
  @IsString()
  @MaxLength(60)
  legacyRef: string;
}

export class ImportOwnersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportOwnerRowDto)
  rows: ImportOwnerRowDto[];
}
