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
  Min,
  ValidateNested,
} from 'class-validator';

const SESSION_DURATIONS = ['30m', '1h', '4h'] as const;

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

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  agentId?: number;
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
  @Type(() => Number)
  @IsInt()
  agentId?: number;
}

export class CreateLanGatewayAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
}

export class UpdateLanGatewayAgentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class EnrollLanGatewayAgentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  installCode: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  computerName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  version: string;
}

export class LanGatewayRouteReportDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  appId: number;

  @IsBoolean()
  healthy: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class LanGatewayHeartbeatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  version: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  appliedRevision: number;

  @IsBoolean()
  processRunning: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  error?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LanGatewayRouteReportDto)
  routes: LanGatewayRouteReportDto[];
}
