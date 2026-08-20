import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsArray } from 'class-validator';
import { REPORTER_ROLES, UserRole, UserStatus } from '../../common/enums';

/** 业主档案里可标记的身份：业主本人，或几类替住户报修的人 */
export const MARKABLE_ROLES: UserRole[] = [UserRole.OWNER, ...REPORTER_ROLES];

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

  /**
   * 身份标记。业主 = owner；保安/居委会/业委会/物业工作人员报修时
   * 位置不限于自己家，改这个字段即可，本人在小程序里无需做任何操作。
   */
  @IsOptional()
  @IsIn(MARKABLE_ROLES)
  reporterRole?: UserRole;

  /** 代报授权的小区；传了就整份覆盖，空数组 = 收回全部代报权限 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  reportCommunityIds?: number[];
}
