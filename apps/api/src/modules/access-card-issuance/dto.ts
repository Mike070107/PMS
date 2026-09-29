import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsIn,
  IsOptional,
  IsObject,
  IsString,
  ValidateNested,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { AccessCardAgentKind } from '../../entities/access-card-agent.entity';

export class CreateAccessCardIssueDto {
  @Type(() => Number)
  @IsInt()
  houseId: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  quantity = 1;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  extraBuildingIds?: number[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  workstationId?: string;

  @IsString()
  @MaxLength(80)
  idempotencyKey: string;
}

export class EnrollAccessCardAgentDto {
  @IsIn(['issuer', 'access_gateway', 'legacy_sync', 'parking_gateway'])
  @IsString()
  @MaxLength(30)
  kind: AccessCardAgentKind;

  @IsString()
  @MaxLength(100)
  name: string;
}

export class AgentHeartbeatDto {
  @IsString()
  @MaxLength(30)
  version: string;

  @IsObject()
  capabilities: Record<string, boolean>;
}

export class AgentReportDto {
  @Type(() => Number)
  @IsInt()
  itemId: number;

  @IsIn(['success', 'retry', 'failed'])
  @IsString()
  @MaxLength(30)
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icCardNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  legacyPersonNo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  legacyHouseSequence?: number;

  @IsOptional()
  @IsArray()
  controllerResults?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  errorRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class CardPreflightDto {
  @Type(() => Number)
  @IsInt()
  itemId: number;

  @IsString()
  @MaxLength(40)
  icCardNo: string;
}

export class LegacyCardMatchDto {
  @Type(() => Number)
  @IsInt()
  personId: number;

  @IsString()
  @MaxLength(40)
  personNo: string;

  @IsString()
  @MaxLength(120)
  personName: string;

  @IsString()
  @MaxLength(40)
  icCardNo: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  issuedAt?: string;
}

export class LegacyCardCheckReportDto {
  @Type(() => Number)
  @IsInt()
  checkId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => LegacyCardMatchDto)
  matches?: LegacyCardMatchDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class LegacyHistoryEntryDto {
  @Type(() => Number)
  @IsInt()
  personId: number;

  @IsString()
  @MaxLength(40)
  personNo: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  sequence: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icCardNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  issuedAt?: string;
}

export class LegacyHistoryReportDto {
  @Type(() => Number)
  @IsInt()
  snapshotId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LegacyHistoryEntryDto)
  history?: LegacyHistoryEntryDto[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  issuedCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  nextSequence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class CreateParkingQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  term: string;
}

export class CreateParkingProofUploadDto {
  @IsString()
  @MinLength(5)
  @MaxLength(20)
  plate: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  ownerId?: string;
}

export class ParkingQueryRowDto {
  @IsString()
  @MaxLength(80)
  database: string;

  @IsObject()
  fields: Record<string, string | number | boolean | null>;
}

export class ParkingQueryReportDto {
  @Type(() => Number)
  @IsInt()
  queryId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ParkingQueryRowDto)
  rows?: ParkingQueryRowDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}
