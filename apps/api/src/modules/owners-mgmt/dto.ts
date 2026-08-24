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

}
