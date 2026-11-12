import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ArrayMaxSize,
  Matches,
  IsDateString,
  Min,
} from 'class-validator';
import { IsArray, ValidateNested } from 'class-validator';
import { UserStatus } from '../../common/enums';

export class ListOwnersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  id?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

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

export class OwnerPropertyDatesDto {
  @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  moveInDate?: string | null;
  @IsOptional() @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  billingStartDate?: string | null;
}

export class CreateOwnerDto extends OwnerPropertyDatesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[+\d][\d\s()+-]{4,29}$/, { each: true, message: '联系电话格式不正确' })
  contactPhones?: string[];
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ownerBuildingId?: number | null;
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

export class UpdateOwnerDto extends OwnerPropertyDatesDto {
  /** Editing one association must explicitly name it; other associations remain untouched. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  currentHouseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  currentOwnerBuildingId?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(/^[+\d][\d\s()+-]{4,29}$/, { each: true, message: '联系电话格式不正确' })
  contactPhones?: string[];
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ownerBuildingId?: number | null;
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

export class BusinessContactsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  houseId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  buildingId?: number;
}

export class UpdateBusinessContactDto {
  @IsOptional() @IsString() @MaxLength(60) @Matches(/\S/)
  name?: string;
  @IsOptional() @IsString() @Matches(/^[+\d][\d\s()+-]{4,29}$/)
  phone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true })
  @Matches(/^[+\d][\d\s()+-]{4,29}$/, { each: true })
  contactPhones?: string[];
  @IsArray() @ArrayMaxSize(10) @IsString({ each: true })
  @Matches(/^[+\d][\d\s()+-]{4,29}$/, { each: true })
  confirmedPhones: string[];
  @IsIn(['cashier', 'parking'])
  source: 'cashier' | 'parking';
}

// ---------------- 批量导入 ----------------

export class OwnerPropertyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ownerBuildingId?: number;
}

export class OwnerPhoneEventDto {
  @IsString()
  @MaxLength(30)
  phone: string;

  @IsIn(['connected', 'no_answer', 'invalid', 'inactive'])
  result: 'connected' | 'no_answer' | 'invalid' | 'inactive';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

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
