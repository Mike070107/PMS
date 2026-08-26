import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ASSIGNABLE_STAFF_ROLES } from '../../common/enums';
import { ALL_PAGE_KEYS, RoleDataScope } from '../../common/pages';

export class RolePermissionDto {
  @IsIn([...ALL_PAGE_KEYS])
  pageKey: string;

  @IsBoolean()
  canView: boolean;

  @IsBoolean()
  canEdit: boolean;

  @IsBoolean()
  canDelete: boolean;
}

export class SaveRoleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;

  /**
   * 业务身份：这个角色的人在物业里干哪一行（决定小程序端能力、审批链、登录哪个端）。
   * 不传 / null = 纯后台角色，不上小程序。
   */
  @IsOptional()
  @IsIn([...ASSIGNABLE_STAFF_ROLES, null])
  businessRole?: string | null;

  @IsIn(Object.values(RoleDataScope))
  dataScope: RoleDataScope;

  @IsArray()
  @ArrayMaxSize(ALL_PAGE_KEYS.length)
  @ValidateNested({ each: true })
  @Type(() => RolePermissionDto)
  permissions: RolePermissionDto[];

  /** dataScope=offices 时必填 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  officeIds?: number[];

  /** dataScope=communities 时必填（顶层小区 id） */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  communityIds?: number[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
