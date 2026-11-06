import {ArrayMaxSize,ArrayMinSize,ArrayUnique,Equals,IsArray,IsIn,IsInt,IsUUID,Matches,Max,Min} from 'class-validator';
/** Deliberately no tenant, MIS owner, collector or external method id in the browser contract. */
export class CreateMisPostingDto{
 @IsInt() @Min(1) @Max(2147483647) houseId:number;
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(120) @ArrayUnique() @Matches(/^[1-9]\d{0,17}$/,{each:true}) billIds:string[];
 @IsInt() @Min(0) @Max(2147483647) amountCents:number;
 @IsIn(['cash','wechat','alipay','bank','card','other']) paymentMethod:string;
 @Equals(true) confirmed:boolean;
 @IsUUID() idempotencyKey:string;
}
