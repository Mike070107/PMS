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

  /**
   * 额外可见的仓库 id。数据范围只能圈到管理处/小区，总仓不挂管理处 ——
   * 「让这个管理处角色用总公司那个总仓」只能在这里配。传了就整份覆盖。
   */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  warehouseIds?: number[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
