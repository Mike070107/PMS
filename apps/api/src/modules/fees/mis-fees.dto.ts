import { Type, Transform } from 'class-transformer';
import { IsIn,IsInt,IsOptional,IsString,Matches,Max,MaxLength,Min, IsArray, ArrayMaxSize, ArrayUnique, ValidateNested, IsDefined, IsBoolean, IsUUID } from 'class-validator';
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
export class MisResidentialQueryDto extends MisFeesQueryDto {
 @IsOptional() @IsIn(['paid','unpaid']) declare status?:'paid'|'unpaid';
 @IsOptional() @IsIn(['dashboard','households','trend','detail']) view?:'dashboard'|'households'|'trend'|'detail';
 @IsOptional() @IsIn(['all','property','berth','other']) category?:'all'|'property'|'berth'|'other';
 @IsOptional() @Transform(({value})=>typeof value==='string'?value.split(','):value) @IsArray() @ArrayMaxSize(200) @ArrayUnique() @Matches(/^(0[1-4]):[1-9]\d{0,18}:[1-9]\d{0,18}$/,{each:true}) houseKeys?:string[];
}
export class MisCollectionPreviewDto {
 @IsDefined() @ValidateNested() @Type(()=>MisResidentialQueryDto) filter:MisResidentialQueryDto;
 @IsIn(['keys','all']) selection:'keys'|'all';
 @IsOptional() @IsArray() @ArrayMaxSize(200) @ArrayUnique() @Matches(/^(0[1-4]):[1-9]\d{0,18}:[1-9]\d{0,18}$/,{each:true}) houseKeys?:string[];
 @IsIn(['print','sms']) purpose:'print'|'sms';
 @IsOptional() @Matches(/^[a-f0-9]{64}$/) fingerprint?:string;
 @IsOptional() @IsUUID() idempotencyKey?:string;
 @IsOptional() @IsBoolean() confirmed?:boolean;
}
