import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RepairExperienceBlockDto {
  @IsString()
  @MaxLength(80)
  id: string;

  @IsIn(['heading', 'paragraph', 'bullet', 'warning', 'image'])
  type: 'heading' | 'paragraph' | 'bullet' | 'warning' | 'image';

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
}

export class SaveRepairExperienceNoteDto {
  @IsInt()
  @Min(1)
  officeId: number;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  repairType: string;

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
