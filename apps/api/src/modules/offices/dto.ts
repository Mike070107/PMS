import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SaveOfficeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 管辖的顶层小区 id；传了就整份覆盖，不传则不动 */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  communityIds?: number[];
}
