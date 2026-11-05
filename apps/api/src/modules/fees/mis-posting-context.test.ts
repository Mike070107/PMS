import 'reflect-metadata';import assert from 'node:assert/strict';import test from 'node:test';import {MisFeesService} from './mis-fees.service';
test('posting resolves the true scoped house and only selected unpaid source bills, never a browser owner',async()=>{
 const old=process.env.MIS_FEES_TENANT_ID;process.env.MIS_FEES_TENANT_ID='1';try{
 let reads=0;const qb:any={innerJoin(){return this},where(){return this},select(){return this},getRawOne:async()=>({communityId:10,road:'测试路',lane:'198',buildingNo:'1',roomNo:'101'})};
 const svc:any=new MisFeesService({find:async()=>[{id:10,name:'枫桦景苑一期'}]} as any,{createQueryBuilder:()=>qb} as any);
 svc.read=async(sql:string,params:any)=>{reads++;assert.match(sql,/ZJ_ID IN \(@postingBill0\)/);assert.match(sql,/ZJ_SKRQ IS NULL/);assert.equal(params.houseRoom,'101');assert.equal(params.postingBill0,'900719925474099991');return{recordset:[{id:'900719925474099991',ownerId:'900719925474099999',officeCode:'01',feeCode:'01',period:'202601',amount:'123.4500'}]}};
 const context=await svc.postingContext(11,['900719925474099991'],{id:7,tenantId:1},{scopeAll:false,communityIds:[10]});assert.equal(context.ownerId,'900719925474099999');assert.equal(context.bills[0].amountCents,12345);assert.equal(context.communityId,10);
 await assert.rejects(()=>svc.postingContext(11,['900719925474099991'],{id:7,tenantId:1},{scopeAll:false,communityIds:[]}),/范围|授权/);assert.equal(reads,1);
 }finally{old===undefined?delete process.env.MIS_FEES_TENANT_ID:process.env.MIS_FEES_TENANT_ID=old;}
});
