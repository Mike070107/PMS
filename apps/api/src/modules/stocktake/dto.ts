import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class StocktakeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;

  @IsOptional()
  @IsIn(['counting', 'submitted', 'approved', 'rejected', 'cancelled'])
  status?: string;
}

export class CreateStocktakeDto {
  @Type(() => Number)
  @IsInt()
  warehouseId: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}

export class SaveStocktakeItemDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999999999)
  actualQty: number;

  @IsOptional()
  @IsString()
  @IsIn([
    'unregistered_usage',
    'unregistered_inbound',
    'damaged',
    'expired',
    'misplaced',
    'counting_error',
    'other',
  ])
  @MaxLength(40)
  reasonCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  attachments?: string[];
}

export class ReviewStocktakeDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
