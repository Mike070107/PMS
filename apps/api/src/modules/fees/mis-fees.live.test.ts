import test from 'node:test';
import assert from 'node:assert/strict';
import {misFeesFixture} from '../../../test/mis-fees.fixture';
const enabled=process.env.MIS_FEES_LIVE_TEST==='true'&&!!process.env.MIS_FEES_TEST_PMS_SNAPSHOT;
test('真实MIS按户查询、汇总、分页与授权范围',{skip:!enabled},async()=>{
 const fixture=await misFeesFixture(process.env.MIS_FEES_TEST_PMS_SNAPSHOT!);
 const user={id:1,tenantId:1,role:'staff'},access={scopeAll:true} as any;
 try{
  const opts=await fixture.service.metadata(user,access);assert.equal(opts.available,true);assert.equal(opts.communities.length,3);assert.ok(!opts.communities.some(x=>/北桥|颛桥/.test(x.name)));
  const houses=await fixture.service.searchHouses(1,'2号101',user,access);assert.ok(houses.rows.some(x=>x.id===1));
  const q={communityId:1,houseId:1,periodFrom:'202601',periodTo:'202612',pageSize:5};
  const first=await fixture.service.list({...q,page:1},user,access),second=await fixture.service.list({...q,page:2},user,access);
  assert.ok(first.total>5);assert.equal(first.rows.length,5);assert.equal(second.total,first.total);assert.equal(second.rows.length,5);
  assert.equal(first.summary.receivableCents,first.summary.paidCents+first.summary.unpaidCents);
  assert.ok(first.rows.every((r:any)=>r.communityId===1&&r.address.includes('198弄2号101')));
  assert.ok(!first.rows.some((r:any)=>second.rows.some((s:any)=>s.id===r.id)));
  await assert.rejects(fixture.service.list({communityId:16},user,{scopeAll:false,communityIds:[1]} as any),/授权范围/);
  await assert.rejects(fixture.service.searchHouses(21,'',user,access),/授权范围/);
  console.log(JSON.stringify({liveMIS:true,houseId:1,total:first.total,summary:first.summary,pageSize:5}));
 }finally{await fixture.close();}
});
