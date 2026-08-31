import {
  IsBoolean,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

const toBool = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value === 'true' || value === '1' : !!value,
  );

/** 允许显式传 null（解除归组），其余转成整数；字段缺失时保持 undefined（= 不改） */
const toNullableInt = () =>
  Transform(({ value, obj, key }) => {
    if (!(key in (obj ?? {}))) return undefined;
    if (value === null || value === '' || value === undefined) return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : NaN;
  });

export class TenantScopedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;
}

/** 后台录房产时，把一整句地址拆成路名/小区/弄/号/室 */
export class ParseHouseAddressDto extends TenantScopedQueryDto {
  @IsString()
  @MaxLength(200)
  text: string;
}

export class CommunityQueryDto extends TenantScopedQueryDto {
  /** 默认只返回挂房产的小区（分期）；true 时把分组节点也带上 */
  @IsOptional()
  @toBool()
  @IsBoolean()
  includeGroups?: boolean;
}

// ---------------- Communities ----------------

export class CreateCommunityDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsString()
  @MaxLength(120)
  name: string;

  /** 上级小区（分组）id，如「枫桦景苑一期」的上级是「枫桦景苑」。传 null 取消归组 */
  @IsOptional()
  @toNullableInt()
  parentId?: number | null;

  /** 所属管理处 id。只有顶层小区能挂，分期跟随上级；传 null 表示不划入任何管理处 */
  @IsOptional()
  @toNullableInt()
  officeId?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  zones?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateCommunityDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @toNullableInt()
  parentId?: number | null;

  /** 所属管理处 id。只有顶层小区能挂，分期跟随上级；传 null 表示不划入任何管理处 */
  @IsOptional()
  @toNullableInt()
  officeId?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  zones?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

// ---------------- Buildings ----------------

export class CreateBuildingDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  communityId: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  lane?: string;

  @IsString()
  @MaxLength(30)
  buildingNo: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  zone?: string;
}

export class UpdateBuildingDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  lane?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  buildingNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  zone?: string;
}

// ---------------- Houses ----------------

/**
 * 创建房产。
 * 推荐流程：直接传 communityId + lane + buildingNo + roomNo，
 * 后端按 (community, lane, buildingNo) upsert 楼栋，前端无需先建楼栋。
 * 老流程兼容：也可以直接传 buildingId。
 */
export class CreateHouseDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  lane?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  buildingNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  unitId?: number;

  @IsString()
  @MaxLength(30)
  roomNo: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  propertyType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  roadName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  shopName?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: false })
  areaSqm?: string;
}

export class UpdateHouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  roomNo?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: false })
  areaSqm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  propertyType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  roadName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  shopName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  unitId?: number;
}

// ---------------- Query DTOs ----------------

export class BuildingQueryDto extends TenantScopedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}

// ---------------- 公区点位（监控室、门卫室、水泵房…） ----------------

export class CommunitySpotQueryDto extends TenantScopedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}

export class CreateCommunitySpotDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  communityId: number;

  /** 点位在某一栋楼里（「3号楼电梯机房」）；不传 = 整个小区的公共点位 */
  @IsOptional()
  @toNullableInt()
  buildingId?: number | null;

  @IsString()
  @MaxLength(60)
  name: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @toBool()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateCommunitySpotDto {
  @IsOptional()
  @toNullableInt()
  buildingId?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @toBool()
  @IsBoolean()
  enabled?: boolean;
}

export class HouseQueryDto extends TenantScopedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  /** 按 弄 / 号 / 室 / 业主姓名 / 业主电话 模糊搜 */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  /**
   * 传了 page 就走服务端分页，返回 { rows, total, page, pageSize }；
   * 不传仍返回数组（房号搜索下拉、前台收费、物业费那几处调用方按数组用，别改它们的口径）。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;
}

// ---------- 小程序地址簿 ----------

export class AddressBookQueryDto {
  /** 业主还没有 tenantId 时必传，用它反查租户 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}
