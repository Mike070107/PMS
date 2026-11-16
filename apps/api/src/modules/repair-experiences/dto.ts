import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  Max,
  ArrayUnique,
  ValidateNested,
} from 'class-validator';

export class RepairExperienceBlockDto {
  @IsString()
  @MaxLength(80)
  id: string;

  @IsIn(['heading', 'paragraph', 'bullet', 'ordered', 'checklist', 'quote', 'warning', 'divider', 'image', 'document'])
  type: 'heading' | 'paragraph' | 'bullet' | 'ordered' | 'checklist' | 'quote' | 'warning' | 'divider' | 'image' | 'document';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  caption?: string;

  @IsOptional()
  @IsBoolean()
  checked?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120000)
  html?: string;
}

export class SaveRepairExperienceNoteDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  officeId?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  repairType?: string;

  @IsOptional()
  @IsIn(['private', 'published'])
  visibility?: 'private' | 'published';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  communityIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(60, { each: true })
  repairTypes?: string[];

  @IsOptional()
  @IsBoolean()
  allowEdit?: boolean;

  @IsOptional()
  @IsBoolean()
  allowDelete?: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title: string;

  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => RepairExperienceBlockDto)
  blocks: RepairExperienceBlockDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  revision?: number;
}

export class ExperienceLibraryQueryDto {
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsIn(['all', 'mine', 'private', 'favorites']) view?: 'all' | 'mine' | 'private' | 'favorites';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) communityId?: number;
  @IsOptional() @IsString() @MaxLength(60) repairType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
export class DeleteExperienceQueryDto {
  @Type(() => Number) @IsInt() @Min(1) revision: number;
}
