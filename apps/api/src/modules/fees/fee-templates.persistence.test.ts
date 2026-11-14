import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fee-templates.test-fixture';
import { todayInTz } from './report.util';
import { UserRole } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';

const today=todayInTz(new Date());
const tomorrow=new Date(new Date(`${today}T00:00:00Z`).getTime()+86400000).toISOString().slice(0,10);
const user={id:7,tenantId:1,role:UserRole.STAFF};
const scope={communityId:1,kind:'apartment' as const};
const item=(price=80000)=>({feeCode:'rent',unitPriceCents:price,unit:'月',calculation:'fixed',cycle:'month'});

test('隔离PostgreSQL：过期版本、范围变化、无效日期拒绝且不留半成品',async()=>{
  const {pg,service,db}=await fixture();
  try {
    const created=await service.save({...scope,name:'校验模板',effectiveFrom:today,items:[item()]},user);
    await assert.rejects(service.assign({...scope,templateId:created.id,expectedRevision:0,expectedCount:2,all:true,effectiveFrom:today},user),/价格已变化/);
    await assert.rejects(service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:3,all:true,effectiveFrom:today},user),/户数已变化/);
    await assert.rejects(service.save({...scope,name:'无效',effectiveFrom:'2026-02-30',items:[item()]},user),/日期无效/);
    await assert.rejects(service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:1,houseIds:[101],effectiveFrom:today,overrides:{electricity:100}},user),/项目/);
    assert.equal((await db.query('SELECT count(*)::int count FROM fee_template_assignments'))[0].count,0);
    assert.equal((await db.query('SELECT count(*)::int count FROM fee_templates'))[0].count,1);
  }finally{await pg.close();}
});

test('隔离PostgreSQL：迁移→模板→批量套用→统一调价→例外→历史账不回写',async()=>{
  const {pg,service,db}=await fixture();
  try {
    const created=await service.save({...scope,name:'标准房',effectiveFrom:today,items:[item()]},user);
    assert.deepEqual(await service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:2,all:true,effectiveFrom:today},user),{changed:2,total:2});
    const current=await service.resolve(1,101,today);
    assert.equal(current.items[0].amountCents,80000);
    await db.query(`INSERT INTO fee_bills(house_id,amount_cents,snapshot) VALUES($1,$2,$3)`,[101,80000,JSON.stringify(current)]);
    await service.save({...scope,name:'标准房',effectiveFrom:today,expectedRevision:1,items:[item(90000)]},user,undefined,created.id);
    assert.equal((await service.resolve(1,102,today)).items[0].amountCents,90000);
    await service.assign({...scope,templateId:created.id,expectedRevision:2,expectedCount:1,houseIds:[101],effectiveFrom:today,overrides:{rent:0}},user);
    assert.equal((await service.resolve(1,101,today)).items[0].amountCents,0);
    await service.save({...scope,name:'标准房',effectiveFrom:tomorrow,expectedRevision:2,items:[item(100000)]},user,undefined,created.id);
    assert.equal((await service.resolve(1,102,today)).version,2);
    assert.equal((await service.resolve(1,102,tomorrow)).items[0].amountCents,100000);
    assert.equal((await service.resolve(1,101,tomorrow)).items[0].amountCents,0);
    assert.equal((await db.query('SELECT amount_cents FROM fee_bills'))[0].amount_cents,80000);
    const catalog=await service.list(scope,user);
    assert.equal(catalog.templates[0].versions.length,3);
    assert.equal(catalog.templates[0].assigned_count,2);
    const houses=await service.houses({...scope,filter:'override'},user);
    assert.equal(houses.total,1);assert.equal(houses.rows[0].id,101);
    await assert.rejects(service.disable(created.id,scope,user),/仍有2户/);
  }finally{await pg.close();}
});

test('隔离PostgreSQL：跨公司、跨门店、跨类别拒绝；不完整面积整体回滚',async()=>{
  const {pg,service,db}=await fixture();
  try {
    const access={scopeAll:false,communityIds:[2]} as unknown as ResolvedAccess;
    await assert.rejects(service.list(scope,user,access),/无权/);
    assert.equal((await service.communities(user,access)).length,1);
    assert.deepEqual(await service.communities(user,{scopeAll:false,communityIds:[]} as unknown as ResolvedAccess),[]);
    const created=await service.save({...scope,name:'按面积',effectiveFrom:today,items:[{...item(120),unit:'㎡',calculation:'area'}]},user);
    await assert.rejects(service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:2,all:true,effectiveFrom:today},user),/缺少有效建筑面积/);
    assert.equal((await db.query('SELECT count(*)::int n FROM fee_template_assignments'))[0].n,0);
    await assert.rejects(service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:1,houseIds:[201],effectiveFrom:today},user),/套用范围|不属于/);
    await assert.rejects(service.save({...scope,communityId:3,name:'越权',effectiveFrom:today,items:[item()]},user),/不存在/);
    await assert.rejects(service.save({...scope,communityId:2,name:'错误类别',effectiveFrom:today,items:[item()]},user),/跨类别/);
    assert.equal((await service.communities(user)).length,2);
  }finally{await pg.close();}
});

test('隔离PostgreSQL：旧标准精确归并，模板绑定不复制标准，重复归并不新增',async()=>{
  const {pg,service,db}=await fixture();
  try {
    await db.query(`INSERT INTO fee_standards(tenant_id,community_id,house_id,fee_code,amount_cents,status,effective_from) VALUES(1,1,101,'rent',80000,'active',$1),(1,1,102,'rent',80000,'active',$1)`,[today]);
    const preview=await service.legacyPreview(scope,user);
    assert.equal(preview.houses,2);assert.equal(preview.groups.length,1);
    await service.importLegacy({...scope,fingerprint:preview.fingerprint,effectiveFrom:today},user);
    assert.equal((await db.query('SELECT count(*)::int n FROM fee_standards'))[0].n,2);
    assert.equal((await service.legacyPreview(scope,user)).houses,0);
    await assert.rejects(service.importLegacy({...scope,fingerprint:preview.fingerprint,effectiveFrom:today},user),/重新预览/);
    const generated=await service.generationStandards(1,1,today);
    assert.equal(generated.standards.length,2);
    assert.equal(generated.standards[0].templateSnapshot.version,1);
  }finally{await pg.close();}
});

test('公寓目录与作用域以房产档案分类为准，不由旧房号类型反推',async()=>{
  const {pg,service,db}=await fixture();
  try {
    await db.query(`UPDATE houses SET property_type=CASE WHEN id IN(101,102) THEN '住宅' ELSE '公寓' END`);
    const catalog=await service.communities(user);
    assert.equal(catalog.find((c:any)=>c.id===1)?.kind,'apartment');
    assert.equal(catalog.find((c:any)=>c.id===2)?.kind,'residential');
    const created=await service.save({...scope,name:'档案公寓标准',effectiveFrom:today,items:[item()]},user);
    assert.equal((await service.list(scope,user)).templates[0].id,created.id);
    assert.equal((await service.houses(scope,user)).total,2);
    assert.equal((await service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:2,all:true,effectiveFrom:today},user)).changed,2);
    assert.equal((await service.resolve(1,101,today)).items[0].amountCents,80000);
    await assert.rejects(service.list({...scope,kind:'residential'},user),/跨类别/);
    await assert.rejects(service.list({...scope,communityId:2},user),/跨类别/);
    assert.equal((await db.query('SELECT property_type FROM houses WHERE id=101'))[0].property_type,'住宅');
  }finally{await pg.close();}
});

test('房产分类纠正后保留旧类别模板及绑定，不隐式改价或复制标准',async()=>{
  const {pg,service,db}=await fixture();
  try {
    await db.query("UPDATE communities SET community_type='community' WHERE id=1");
    const oldScope={...scope,kind:'residential' as const};
    const created=await service.save({...oldScope,name:'既有标准',effectiveFrom:today,items:[item()]},user);
    await service.assign({...oldScope,templateId:created.id,expectedRevision:1,expectedCount:2,all:true,effectiveFrom:today},user);
    const previous=await service.resolve(1,101,today);
    await db.query("UPDATE communities SET community_type='apartment' WHERE id=1");
    const listed=await service.list(scope,user);
    assert.equal(listed.templates.length,1);assert.equal(listed.templates[0].id,created.id);
    assert.equal(listed.templates[0].kind,'apartment');
    assert.deepEqual(await service.resolve(1,101,today),previous);
    await assert.rejects(service.save({...scope,name:'既有标准',effectiveFrom:today,items:[item()]},user),/同名/);
    assert.equal((await service.assign({...scope,templateId:created.id,expectedRevision:1,expectedCount:2,all:true,effectiveFrom:today},user)).changed,0);
    await assert.rejects(service.disable(created.id,scope,user),/仍有2户/);
    assert.equal((await db.query('SELECT kind FROM fee_templates WHERE id=$1',[created.id]))[0].kind,'residential');
    assert.equal((await db.query('SELECT count(*)::int n FROM fee_template_versions'))[0].n,1);
    await service.save({...scope,name:'既有标准',expectedRevision:1,effectiveFrom:today,items:[item()]},user,undefined,created.id);
    assert.equal((await service.list(scope,user)).templates[0].revision,2);
  }finally{await pg.close();}
});

test('空叶子公寓可配置；分组和停用项不入目录且直传不能写入',async()=>{
  const {pg,service,db}=await fixture();
  try {
    await db.query(`INSERT INTO communities(id,tenant_id,name,enabled,community_type,parent_id) VALUES
      (4,1,'空顶层公寓',true,'apartment',NULL),(5,1,'公寓分组',true,'apartment',NULL),
      (6,1,'子公寓',true,'apartment',5),(7,1,'停用公寓',false,'apartment',NULL),
      (8,2,'跨租户子节点',true,'apartment',4)`);
    const catalog=await service.communities(user);
    assert.deepEqual(catalog.map((c:any)=>c.id),[1,2,4,6]);
    const emptyScope={...scope,communityId:4};
    const created=await service.save({...emptyScope,name:'预配置标准',effectiveFrom:today,items:[item()]},user);
    assert.equal((await service.list(emptyScope,user)).templates[0].id,created.id);
    assert.equal((await service.houses(emptyScope,user)).total,0);
    await assert.rejects(service.assign({...emptyScope,templateId:created.id,expectedRevision:1,expectedCount:0,all:true,effectiveFrom:today},user),/1—5000/);
    for(const id of [5,7]) await assert.rejects(service.save({...scope,communityId:id,name:'不可配置',effectiveFrom:today,items:[item()]},user),/不存在|分组|停用/);
    const access={scopeAll:false,communityIds:[4,5,7,8]} as unknown as ResolvedAccess;
    assert.deepEqual((await service.communities(user,access)).map((c:any)=>c.id),[4]);
    await assert.rejects(service.list({...scope,communityId:6},user,access),/无权/);
    assert.equal((await db.query('SELECT count(*)::int n FROM fee_templates'))[0].n,1);
  }finally{await pg.close();}
});
