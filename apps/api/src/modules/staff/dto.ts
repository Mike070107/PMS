import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ASSIGNABLE_STAFF_ROLES, UserRole, UserStatus } from '../../common/enums';

/**
 * 后台可开通的业务身份，与角色表 business_role 的取值域同一份（common/enums.ts）。
 * 保安/居委会/业委会也在这里登记 —— 他们只用小程序报修、不进后台，
 * 但同样需要物业先登记、能停用、能改授权小区，走员工那套管理流程最省事。
 */
const ASSIGNABLE_ROLES = ASSIGNABLE_STAFF_ROLES;

/** 工作范围一行：在某管理处（null = 全部管理处）做哪些工种 */
export class StaffAssignmentDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  officeId?: number | null;

  @IsArray()
  @IsString({ each: true })
  skills!: string[];
}

export class ListStaffQueryDto {
  /** 按绑定的业务角色筛（角色 id） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  roleId?: number;

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

  /** 工作范围（员工 × 管理处 × 工种）；不传则按角色旧范围推出（旧后台兼容） */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StaffAssignmentDto)
  assignments?: StaffAssignmentDto[];
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

  /** 工作范围；传了就整份覆盖 */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StaffAssignmentDto)
  assignments?: StaffAssignmentDto[];
}

/**
 * 「自动生成账号密码」的入参。只拿姓名去拟，不落库。
 * 编辑已有用户时带上 excludeUserId，否则他自己占着的账号会让系统白白跳到 01。
 */
export class SuggestCredentialsDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  excludeUserId?: number;
}
