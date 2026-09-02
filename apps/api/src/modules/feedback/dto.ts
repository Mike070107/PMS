import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateUserFeedbackDto {
  @IsString()
  @Length(1, 500)
  content: string;

  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  imageUrls: string[] = [];

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  videoUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15)
  videoDurationSeconds?: number;
}
