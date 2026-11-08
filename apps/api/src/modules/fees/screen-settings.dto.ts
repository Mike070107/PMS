import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ScreenSummaryQueryDto } from './collection-targets.dto';
export class ScreenManualDto {
  @IsBoolean() sample: boolean;
  @IsDateString({ strict: true }) asOf: string;
  @IsString() @MaxLength(200) note: string;
  @IsInt() @Min(0) @Max(1000000) overdueHouses: number;
  @IsInt() @Min(0) @Max(1000000000000) overdueCents: number;
  @IsInt() @Min(0) @Max(1000000) untouchedHouses: number;
  @IsInt() @Min(0) @Max(1000000000000) untouchedCents: number;
  @IsInt() @Min(0) @Max(1000000) disputeCount: number;
  @IsInt() @Min(0) @Max(1000000000000) disputeCents: number;
  @IsInt() @Min(0) @Max(1000000000000) recoveredCents: number;
  @IsInt() @Min(0) @Max(1000000) duePromises: number;
  @IsInt() @Min(0) @Max(1000000) keptPromises: number;
  @IsInt() @Min(0) @Max(1000000) pendingHouses: number;
}
export class ScreenOwnerDto {
  @IsInt() @Min(1) communityId: number;
  @IsString() @MaxLength(40) name: string;
}
export class SaveScreenSettingsDto extends ScreenSummaryQueryDto {
  @IsInt() @Min(0) @Max(2147483647) revision: number;
  @IsOptional() @ValidateNested() @Type(() => ScreenManualDto) manual?: ScreenManualDto;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ScreenOwnerDto) owners: ScreenOwnerDto[];
}
