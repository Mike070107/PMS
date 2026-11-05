import {Type} from 'class-transformer';import {IsDateString,IsIn,IsInt,IsOptional,IsString,Matches,Max,MaxLength,Min} from 'class-validator';
export class BusinessLedgerQueryDto{
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(1000000) page?:number;
 @IsOptional() @Type(()=>Number) @IsIn([20,50,100]) pageSize?:number;
 @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) from?:string;
 @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({strict:true}) to?:string;
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) @Max(2147483647) communityId?:number;
 @IsOptional() @IsString() @MaxLength(120) q?:string;
 @IsOptional() @IsIn(['parking_monthly','access_card','mis_property','mis_berth']) serviceType?:string;
 @IsOptional() @IsIn(['paid','refunded','cancelled']) status?:string;
 @IsOptional() @IsIn(['free']) kind?:string;
}
