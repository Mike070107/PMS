import {
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RegisterOwnerDto {
  @Type(() => Number)
  @IsInt()
  tenantId: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  wxOpenid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  wxUnionid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @ValidateIf((value: RegisterOwnerDto) => !value.wxOpenid && !value.wxUnionid)
  @IsPhoneNumber('CN')
  phone?: string;

  @Type(() => Number)
  @IsInt()
  communityId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  rawAddress?: string;
}

export class ListAuditsQueryDto {
  @IsOptional()
  @IsString()
  status?: string;
}

export class ApproveAuditDto {
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
  unitId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  roomNo?: string;
}

export class RejectAuditDto {
  @IsString()
  @MaxLength(255)
  reason: string;
}
