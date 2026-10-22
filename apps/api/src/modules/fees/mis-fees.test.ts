import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMisFeeQuery, misFeeStatus, misMoneyToCents, validateMisFeeRange } from './mis-fees.query';
import { MisFeesService } from './mis-fees.service';

test('MIS账期使用ZJ_CNY，排除北桥，SQL2008分页不使用OFFSET',()=>{
 const q=buildMisFeeQuery({periodFrom:'202601',periodTo:'202612',page:2,pageSize:20},['01','02','03']);
 assert.match(q.sql,/ZJ_CNY/);assert.doesNotMatch(q.sql,/ZJ_NY/);assert.match(q.sql,/ROW_NUMBER\(\)/);assert.doesNotMatch(q.sql,/\bOFFSET\b/i);
 assert.equal(q.params.firstRow,21);assert.equal(q.params.lastRow,40);assert.deepEqual(q.params.office0,'01');
 assert.throws(()=>buildMisFeeQuery({},['05']),/范围/);
});
test('房屋、姓名、单据搜索参数化，通配符按文字搜索',()=>{
 const attack="%' OR 1=1--";const q=buildMisFeeQuery({q:attack,status:'unpaid'},['02']);
 assert.ok(!q.sql.includes(attack));assert.equal(q.params.search,"%[%]' OR 1=1--%");
 assert.match(q.sql,/ZJ_SKRQ IS NULL/);assert.match(q.sql,/ZJ_TKRQ IS NULL/);assert.match(q.sql,/ZJ_JE>=0/);
});
test('退款优先于已收，负数调整单独展示，不重复扣退款',()=>{
 assert.equal(misFeeStatus({amountCents:-15000,paidAt:'2026-09-22',refundedAt:'2026-10-19'}),'refunded');
 assert.equal(misFeeStatus({amountCents:-15000,paidAt:'2026-09-22'}),'adjustment');
 assert.equal(misFeeStatus({amountCents:15000,paidAt:'2026-10-21'}),'paid');
 assert.equal(misFeeStatus({amountCents:15000}),'unpaid');
});
test('应缴、已缴汇总排除退款与负数调整，保留money四位小数',()=>{
 const q=buildMisFeeQuery({},['01']);
 assert.match(q.sql,/w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0/);
 assert.match(q.sql,/END\),2\) AS receivableAmount/);
 assert.match(q.sql,/CONVERT\(varchar\(50\),w.ZJ_JE,2\)/);
});
test('金额按十进制转分，不用二进制浮点截断',()=>{
 assert.equal(misMoneyToCents('128.07'),12807);assert.equal(misMoneyToCents('-0.01'),-1);
 assert.equal(misMoneyToCents('128.0750'),12808);assert.equal(misMoneyToCents('-128.0750'),-12808);
 assert.throws(()=>misMoneyToCents('NaN'),/金额/);
});
test('拒绝倒置账期、非法日期和越界分页',()=>{
 for(const q of [{periodFrom:'202613'},{periodFrom:'202612',periodTo:'202601'},{paidFrom:'2026-02-30'},{pageSize:501},{page:0}])assert.throws(()=>validateMisFeeRange(q),/账期|日期|分页/);
});

test('其他公司、空授权范围和未授权房号不能触发MIS查询',async()=>{
 const previous=process.env.MIS_FEES_TENANT_ID;process.env.MIS_FEES_TENANT_ID='1';
 try{
  const communities:any={find:async()=>[{id:1,name:'枫桦景苑一期'},{id:2,name:'枫桦景苑二期'},{id:16,name:'上海新家'},{id:21,name:'馨香臣寓颛桥店'}]};
  const service:any=new MisFeesService(communities,{} as any);let reads=0;service.read=async()=>{reads++;return {};};
  await assert.rejects(service.list({},{tenantId:2,id:1}),/范围/);
  await assert.rejects(service.list({},{tenantId:1,id:1},{scopeAll:false,communityIds:[]}),/范围/);
  await assert.rejects(service.list({communityId:2},{tenantId:1,id:1},{scopeAll:false,communityIds:[1]}),/范围/);
  await assert.rejects(service.list({communityId:21},{tenantId:1,id:1},{scopeAll:true}),/范围/);
  assert.equal(reads,0);
 }finally{if(previous===undefined)delete process.env.MIS_FEES_TENANT_ID;else process.env.MIS_FEES_TENANT_ID=previous;}
});
test('MIS服务拒绝写语句，负载不进入源库驱动',async()=>{
 const service:any=new MisFeesService({} as any,{} as any);
 await assert.rejects(service.read('UPDATE dbo.WYZJ SET ZJ_JE=0'),/只读/);
 await assert.rejects(service.read('SELECT 1; DELETE FROM dbo.WYZJ'),/只读/);
});
test('商铺沿用门牌归一规则，不以PMS内部房号ID查询源库',()=>{
 const q=buildMisFeeQuery({houseId:999},['04'],{road:'通海路',lane:'',buildingNo:'348甲',roomNo:'商铺',shop:true});
 assert.match(q.sql,/非居住/);assert.equal(q.params.houseNumber,'348甲');assert.ok(!q.sql.includes('999'));
});
