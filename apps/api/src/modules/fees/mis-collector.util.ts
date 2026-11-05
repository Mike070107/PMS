/** Server-only mapping; never accept a collector or a MIS payment-method id from HTTP. */
export function resolveMisCollector(config:string|undefined,tenantId:number,userId:number,method:string):{collectorId:string;collectorName:string;paymentMethodId:number;paymentMethod:string}{
 const refuse=():never=>{throw new Error('MIS实际收款人/收款方式映射缺失或非法，请由管理员核实本人映射后再办理');};
 let parsed:any;try{parsed=JSON.parse(config||'');}catch{return refuse();}
 if(!Number.isSafeInteger(tenantId)||tenantId<1||!Number.isSafeInteger(userId)||userId<1||!['cash','wechat','alipay','bank','card','other'].includes(method))return refuse();
 const tenant=parsed?.tenants?.[String(tenantId)],collector=tenant?.collectors?.[String(userId)],payment=tenant?.methods?.[method];
 const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=50&&!/[\x00-\x1f]/.test(v);
 if(!text(collector?.id)||!text(collector?.name)||!text(payment?.name)||!Number.isInteger(payment?.id)||payment.id<1||payment.id>2147483647)return refuse();
 return {collectorId:collector.id,collectorName:collector.name,paymentMethodId:payment.id,paymentMethod:payment.name};
}

