import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsIn,
  IsOptional,
  IsObject,
  IsNumberString,
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

  @IsIn(['success', 'access_db_written', 'retry', 'failed'])
  @IsString()
  @MaxLength(30)
  result: 'success' | 'access_db_written' | 'retry' | 'failed';

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

export class AccessPermissionEntryDto {
  @IsString()
  @MaxLength(20)
  wgCardNo: string;

  @IsIn(['mjsystem', 'iccard'])
  accessSystem: 'mjsystem' | 'iccard';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  buildingNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  controller?: string;

  @IsString()
  @MaxLength(120)
  door: string;

  @IsIn(['MJ_MacPower', 't_d_Privilege'])
  sourceTable: 'MJ_MacPower' | 't_d_Privilege';
}

export class AccessPermissionReportDto {
  @Type(() => Number)
  @IsInt()
  snapshotId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => AccessPermissionEntryDto)
  permissions?: AccessPermissionEntryDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class CreateAccessCardAuthorizationDto {
  @IsArray()
  @ArrayMaxSize(12)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  targetBuildingIds: number[];

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey: string;
}

export class AccessCardAuthorizationReportDto {
  @Type(() => Number)
  @IsInt()
  taskId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  controllerResults?: Array<Record<string, unknown>>;

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

export class ParkingOwnerValuesDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  room?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  note?: string | null;
}

export class ParkingOwnerFieldHintsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  room?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  note?: string | null;
}

export class CreateParkingOwnerUpdateDto {
  @IsIn(['parking1', 'parking2'])
  database: 'parking1' | 'parking2';

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  externalOwnerId: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  plate?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pmsUserId?: number | null;

  @IsString()
  @MinLength(8)
  @MaxLength(80)
  idempotencyKey: string;

  @ValidateNested()
  @Type(() => ParkingOwnerValuesDto)
  expected: ParkingOwnerValuesDto;

  @ValidateNested()
  @Type(() => ParkingOwnerValuesDto)
  values: ParkingOwnerValuesDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ParkingOwnerFieldHintsDto)
  fieldHints?: ParkingOwnerFieldHintsDto;
}

export class ParkingOwnerUpdateReportDto {
  @Type(() => Number)
  @IsInt()
  taskId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @ValidateNested()
  @Type(() => ParkingOwnerValuesDto)
  values?: ParkingOwnerValuesDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class CreateParkingOperationDto {
  @IsIn(['parking1', 'parking2'])
  database: 'parking1' | 'parking2';

  @IsIn(['add_vehicle', 'renew_vehicle', 'change_plate', 'rebind_owner', 'update_garages', 'download_vehicle', 'delete_vehicle'])
  kind: 'add_vehicle' | 'renew_vehicle' | 'change_plate' | 'rebind_owner' | 'update_garages' | 'download_vehicle' | 'delete_vehicle';

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceRecordId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pmsUserId?: number | null;

  @IsObject()
  payload: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  expected?: Record<string, unknown>;
}

export class ParkingOperationReportDto {
  @Type(() => Number)
  @IsInt()
  taskId: number;

  @IsIn(['success', 'retry', 'failed'])
  result: 'success' | 'retry' | 'failed';

  @IsOptional()
  @IsObject()
  values?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
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

export class ParkingHistoryQueryDto {
  @IsOptional()
  @IsNumberString()
  pmsUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  database?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalOwnerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceRecordId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  plate?: string;
}
