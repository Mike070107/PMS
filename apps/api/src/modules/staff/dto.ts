import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { REPORTER_ROLES, UserRole, UserStatus } from '../../common/enums';

/**
 * 后台可开通的账号角色。
 * 保安/居委会/业委会也在这里登记 —— 他们不进后台，用业主端小程序，
 * 但同样需要物业先登记、能停用、能改授权小区，走员工那套管理流程最省事。
 */
const ASSIGNABLE_ROLES: UserRole[] = [
  UserRole.TECHNICIAN,
  UserRole.OFFICE,
  UserRole.MANAGER,
  UserRole.PURCHASER,
  UserRole.ADMIN,
  ...REPORTER_ROLES,
];

export class ListStaffQueryDto {
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: UserRole;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
}

export class CreateStaffDto {
  @IsString()
  @MaxLength(60)
  name: string;

  @IsString()
  @MaxLength(30)
  phone: string;

  @IsIn(ASSIGNABLE_ROLES)
  role: UserRole;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  loginAccount?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password?: string;

  @IsOptional()
  @IsArray()
  skills?: string[];

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  zones?: number[];

  /** 代报角色的授权小区；其它角色忽略 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  reportCommunityIds?: number[];

  /** 绑定的后台角色 id；不传 = 不绑定 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  roleIds?: number[];
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  // 补/改登录账号（维修工建档时可不填，后续需要登录员工端时再补）
  @IsOptional()
  @IsString()
  @MaxLength(60)
  loginAccount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: UserRole;

  @IsOptional()
  @IsIn(Object.values(UserStatus))
  status?: UserStatus;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password?: string;

  @IsOptional()
  @IsArray()
  skills?: string[];

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  zones?: number[];

  /** 代报角色的授权小区；传了就整份覆盖，传空数组=收回全部代报权限 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  reportCommunityIds?: number[];

  /** 绑定的后台角色 id；传了就整份覆盖，传空数组=解绑全部 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  roleIds?: number[];
}
