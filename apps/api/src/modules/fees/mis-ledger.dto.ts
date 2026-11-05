import {IsDateString,IsIn,IsOptional} from 'class-validator';import {MisFeesQueryDto} from './mis-fees.dto';
export class MisLedgerQueryDto extends MisFeesQueryDto{
 @IsOptional() @IsIn(['list','stats']) view?:'list'|'stats';
 @IsOptional() @IsIn([20,50,100]) declare pageSize?:number;
 @IsOptional() @IsDateString({strict:true}) declare paidFrom?:string;
 @IsOptional() @IsDateString({strict:true}) declare paidTo?:string;
 @IsOptional() @IsIn(['paid','refunded','adjustment']) declare status?:'paid'|'refunded'|'adjustment';
}
