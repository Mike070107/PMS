import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fee-templates.test-fixture';
import {todayInTz} from './report.util';
import {UserRole} from '../../common/enums';
const user={id:7,tenantId:1,role:UserRole.STAFF},scope={communityId:1,kind:'apartment' as const};
const today=todayInTz(new Date());
const day=(offset:number)=>new Date(Date.parse(`${today}T00:00:00Z`)+offset*86400000).toISOString().slice(0,10);
const items=[{feeCode:'rent',unitPriceCents:80000,unit:'月',calculation:'fixed',cycle:'month'}];

test('归档守卫覆盖中间未来计划，同日覆盖的旧计划不误拦',async()=>{
 const {pg,service}=await fixture();
 try{
  const ids:number[]=[];
  for(const name of ['A','B','C'])ids.push((await service.save({...scope,name,effectiveFrom:today,items},user)).id);
  for(let n=0;n<3;n++)await service.assign({...scope,templateId:ids[n],expectedRevision:1,expectedCount:1,houseIds:[101],effectiveFrom:day(n)},user);
  const counts=()=>service.list(scope,user).then(x=>x.templates.map((t:any)=>t.assigned_count));
  assert.deepEqual(await counts(),[1,1,1]);
  await assert.rejects(service.disable(ids[1],scope,user),/仍有1户/);
  const tomorrowBefore=await service.resolve(1,101,day(1));
  await service.assign({...scope,templateId:ids[2],expectedRevision:1,expectedCount:1,houseIds:[101],effectiveFrom:day(1)},user);
  assert.deepEqual(await counts(),[1,0,1]);
  await service.disable(ids[1],scope,user);
  assert.equal((await service.list(scope,user)).templates.find((t:any)=>t.id===ids[1]).enabled,false);
  assert.equal(tomorrowBefore.template_id,ids[1]);
  assert.equal((await service.resolve(1,101,day(1))).template_id,ids[2]);
 }finally{await pg.close()}
});

test('中间未来模板的个别调整不能被后续改价静默删去',async()=>{
 const {pg,service,db}=await fixture();
 try{
  const ids:number[]=[];
  for(const name of ['A','B','C'])ids.push((await service.save({...scope,name,effectiveFrom:today,items},user)).id);
  for(let n=0;n<3;n++)await service.assign({...scope,templateId:ids[n],expectedRevision:1,expectedCount:1,houseIds:[101],effectiveFrom:day(n),preserveOverrides:false,...(n===1?{overrides:{rent:75000}}:{})},user);
  await assert.rejects(service.save({...scope,name:'B',expectedRevision:1,effectiveFrom:day(1),items:[{...items[0],feeCode:'management'}]},user,undefined,ids[1]),/项目/);
  assert.equal((await db.query('SELECT count(*)::int n FROM fee_template_versions'))[0].n,3);
  assert.equal((await service.resolve(1,101,day(1))).items[0].amountCents,75000);
 }finally{await pg.close()}
});

test('归档可恢复且幂等：保原ID、历史价格版本和绑定，不自动套用',async()=>{
 const {pg,service,db}=await fixture();
 try{
  const created=await service.save({...scope,name:'待归档标准',effectiveFrom:today,items},user);
  const versions=await db.query('SELECT * FROM fee_template_versions ORDER BY id');
  await service.disable(created.id,scope,user);
  await assert.rejects(service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:1,houseIds:[101],effectiveFrom:today},user),/停用/);
  assert.equal(typeof (service as any).restore,'function','缺少收费标准恢复功能');
  await (service as any).restore(created.id,scope,user);
  assert.equal((await service.list(scope,user)).templates[0].enabled,true);
  const restored=await db.query('SELECT * FROM fee_templates ORDER BY id');
  await (service as any).restore(created.id,scope,user);
  assert.deepEqual(await db.query('SELECT * FROM fee_templates ORDER BY id'),restored);
  assert.deepEqual(await db.query('SELECT * FROM fee_template_versions ORDER BY id'),versions);
  assert.equal((await db.query('SELECT count(*)::int n FROM fee_template_assignments'))[0].n,0);
  await assert.rejects((service as any).restore(created.id,{...scope,communityId:2,kind:'residential'},user),/不存在/);
 }finally{await pg.close()}
});
