import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const SESSION_DURATIONS = ['1h', '4h', '8h', '12h', '24h'] as const;

export class CreateExternalAccessAppDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @MaxLength(255)
  publicHostname: string;

  @IsString()
  @MaxLength(500)
  originUrl: string;

  @IsOptional()
  @IsIn(SESSION_DURATIONS)
  sessionDuration?: (typeof SESSION_DURATIONS)[number];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  userIds: number[];
}

export class UpdateExternalAccessAppDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  publicHostname?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  originUrl?: string;

  @IsOptional()
  @IsIn(SESSION_DURATIONS)
  sessionDuration?: (typeof SESSION_DURATIONS)[number];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  userIds?: number[];
}
