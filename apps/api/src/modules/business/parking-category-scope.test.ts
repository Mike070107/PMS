import assert from 'node:assert/strict';
import test from 'node:test';
import { BusinessService } from './business.service';

test('收费页小区名称只读复用business范围，返回必要id/name且拒绝缺失范围', async()=>{
 const calls:any[]=[];const service:any=Object.create(BusinessService.prototype);
 service.communityRepo={find:async(o:any)=>{calls.push(o);return[{id:1,name:'测试一期'},{id:2,name:'测试二期'}]}};
 assert.deepEqual(await service.feeCommunities({id:7,tenantId:91},{scopeAll:false,communityIds:[2]}),[{id:2,name:'测试二期'}]);
 assert.equal(calls[0].where.tenantId,91);assert.deepEqual(calls[0].select,['id','name']);
 assert.deepEqual(await service.feeCommunities({id:7,tenantId:91},{scopeAll:false,communityIds:[]}),[]);
 await assert.rejects(()=>service.feeCommunities({id:7,tenantId:91},undefined));
});

test('产权车位历史space标记不拦已明确月价，1至60月与收银服务同源计价',()=>{
 const service:any=Object.create(BusinessService.prototype);service.today=()=> '2026-11-06';
 const rule:any={id:11,billingUnit:'space',unitPriceCents:6750,config:{priceMode:'monthly',monthlyPriceCents:6750,discountCycleMonths:12,discountMonths:0,vehicleClass:'产权车位'}};
 for(let months=1;months<=60;months++){
  const r=service.estimateParking(rule,{serviceType:'parking_monthly',months,currentEndDate:'2026-11-30'},91);
  assert.equal(r.amountCents,months*6750);assert.equal(r.quantity,months);
 }
 for(const billingUnit of ['card','year','unknown'])assert.throws(()=>service.estimateParking({...rule,billingUnit},{months:1},91));
 assert.throws(()=>service.estimateParking({...rule,config:{priceMode:'table',tiers:[{months:1,amountCents:6750}]}},{months:1},91));
});
