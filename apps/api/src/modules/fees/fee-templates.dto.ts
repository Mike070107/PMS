import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class TemplateScopeDto {
  @Type(() => Number) @IsInt() @Min(1) communityId: number;
  @IsIn(['apartment','residential']) kind: 'apartment' | 'residential';
}
export class TemplateListDto extends TemplateScopeDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) buildingId?: number;
  @IsOptional() @IsIn(['all','unassigned','override']) filter?: string;
}
export class SaveTemplateDto extends TemplateScopeDto {
  @IsString() @MaxLength(80) name: string;
  @IsArray() @ArrayMaxSize(20) items: unknown[];
  @Matches(/^\d{4}-\d{2}-\d{2}$/) effectiveFrom: string;
  @IsOptional() @IsInt() @Min(1) expectedRevision?: number;
}
export class AssignTemplateDto extends TemplateScopeDto {
  @Type(() => Number) @IsInt() @Min(1) templateId: number;
  @IsInt() @Min(1) expectedRevision: number;
  @IsInt() @Min(1) expectedCount: number;
  @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsInt({each:true}) @Min(1,{each:true}) houseIds?: number[];
  @IsOptional() @IsBoolean() all?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) buildingId?: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) effectiveFrom: string;
  @IsOptional() @IsBoolean() preserveOverrides?: boolean;
  @IsOptional() @IsObject() overrides?: Record<string,number>;
}
export class LegacyTemplateImportDto extends TemplateScopeDto {
  @IsString() fingerprint: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) effectiveFrom: string;
}
