import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsString, Length, Matches, MaxLength } from 'class-validator';
import type { BusinessCommand, IntegrationOperation, Resource } from './protocol';

export class EnrollIntegrationDto {
  @IsString() @Length(1, 100) name: string;
  @IsIn(['workstation', 'service']) kind: 'workstation' | 'service';
  @IsArray() resources: Resource[];
}
export class IntegrationHeartbeatDto {
  @IsIn(['1.0']) protocolVersion: '1.0';
  @IsString() @Length(1, 30) version: string;
  @IsArray() ready: Resource[];
}
export class IntegrationTaskDto {
  @IsString() @Length(1, 80) resourceId: string;
  @IsString() @MaxLength(50) operation: IntegrationOperation;
  @IsInt() @IsIn([1]) revision: 1;
  @IsString() @Length(1, 80) @Matches(/^[a-zA-Z0-9._:-]+$/) idempotencyKey: string;
  @IsObject() command: BusinessCommand;
}
export class IntegrationReportDto {
  @IsString() @Length(64, 64) leaseToken: string;
  @IsObject() result: Record<string, unknown>;
}
export class ParkingQueryRoutesDto {
  @IsObject() routes: Record<string, unknown>;
}
export class IntegrationEnabledDto {
  @IsBoolean() enabled: boolean;
}
