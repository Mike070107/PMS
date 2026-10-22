import { Type } from 'class-transformer';
import { IsIn,IsInt,IsOptional,IsString,Matches,Max,MaxLength,Min } from 'class-validator';
import { MisFeeQuery } from './mis-fees.query';
export class MisHouseSearchDto {
 @Type(()=>Number) @IsInt() @Min(1) communityId:number;
 @IsOptional() @IsString() @MaxLength(60) q?:string;
}
export class MisFeesQueryDto implements MisFeeQuery {
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) communityId?:number;
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) houseId?:number;
 @IsOptional() @IsString() @MaxLength(60) q?:string;
 @IsOptional() @IsString() @MaxLength(20) feeCode?:string;
 @IsOptional() @Matches(/^\d{4}(0[1-9]|1[0-2])$/) periodFrom?:string;
 @IsOptional() @Matches(/^\d{4}(0[1-9]|1[0-2])$/) periodTo?:string;
 @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) paidFrom?:string;
 @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) paidTo?:string;
 @IsOptional() @IsIn(['paid','unpaid','refunded','adjustment']) status?:'paid'|'unpaid'|'refunded'|'adjustment';
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(1000000) page?:number;
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(500) pageSize?:number;
}
