import test from 'node:test';
import assert from 'node:assert/strict';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { screenFixture, manualFixture } from '../../../test/screen-decision-fixture';
import { ScreenSettingsController } from './screen-settings.controller';
import { ScreenSettingsService } from './screen-settings.service';
import { CollectionTargetsService } from './collection-targets.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';
test('大屏人工台账真实PG保存回读、范围隔离和乐观并发',async()=>{
 const f=await screenFixture(),u:any={tenantId:1,id:7},a:any={scopeAll:true};
 try{
  await f.db.query("INSERT INTO communities VALUES(4,1,'未映射公寓',true)");
  const initial=await f.settings.read(u,a,2026);assert.deepEqual(initial.communities.map(c=>c.id),[1,2]);await assert.rejects(f.settings.read(u,a,2026,'4'),/授权范围/);assert.equal(initial.manual,null);assert.equal(initial.revision,0);
  const dto:any={year:2026,revision:0,owners:[{communityId:1,name:'王经理'}],manual:manualFixture};
  const saved=await f.settings.save(u,a,dto);assert.equal(saved.revision,1);assert.equal(saved.manual.overdueHouses,12);
  const read=await f.settings.read(u,a,2026);assert.equal(read.owners[0].name,'王经理');assert.equal(read.manual.sample,true);
  await assert.rejects(f.settings.save(u,a,dto),/其他人修改/);
  await assert.rejects(f.settings.save(u,{scopeAll:false,communityIds:[1]} as any,{...dto,communityIds:'2'}),/授权范围/);
  assert.equal((await f.settings.read(u,{scopeAll:false,communityIds:[1]} as any,2026)).manual,null);
  assert.equal((await f.settings.read({tenantId:2,id:8} as any,a,2026)).manual,null);
  assert.equal((await f.settings.read(u,a,2027)).manual,null);
  await assert.rejects(f.settings.save(u,a,{...dto,revision:1,manual:{...manualFixture,keptPromises:26}}),/不能超过/);
  const results=await Promise.allSettled([f.settings.save(u,a,{...dto,revision:1}),f.settings.save(u,a,{...dto,revision:1})]);assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
 }finally{await f.pg.close();}
});
test('大屏HTTP真实权限守卫、嵌套DTO、目标保存和刷新读回',async()=>{
 const f=await screenFixture(),access:any={hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission};
 @Module({controllers:[ScreenSettingsController],providers:[{provide:ScreenSettingsService,useValue:f.settings},{provide:CollectionTargetsService,useValue:f.targets},JwtAuthGuard,PermissionsGuard,{provide:AccessService,useValue:access}]})class Fixture{}
 const app=await NestFactory.create(Fixture,{logger:false,abortOnError:false});
 for(const mod of (app as any).container.getModules().values())for(const map of [mod.providers,mod.injectables])for(const w of map.values())if(w.instance instanceof JwtAuthGuard)w.instance.canActivate=(ctx:any)=>{const req=ctx.switchToHttp().getRequest();req.user={id:7,tenantId:1};req.access={scopeAll:false,communityIds:[1],pages:{fees:{view:req.headers['x-test-view']==='yes',edit:req.headers['x-test-edit']==='yes'}}};return true;};
 app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));await app.listen(0,'127.0.0.1');
 const base=(await app.getUrl())+'/fees',headers={'content-type':'application/json','x-test-view':'yes','x-test-edit':'yes'};
 const put=(path:string,data:any,h:any=headers)=>fetch(base+path,{method:'PUT',headers:h,body:JSON.stringify(data)});
 try{
  assert.equal((await fetch(base+'/screen-settings?year=2026')).status,403);
  const dto={year:2026,revision:0,owners:[],manual:manualFixture};
  assert.equal((await put('/screen-settings',dto,{...headers,'x-test-edit':'no'})).status,403);
  for(const bad of [{...dto,revision:-1},{...dto,manual:{...manualFixture,overdueHouses:-1}},{...dto,manual:{...manualFixture,asOf:'2026-02-30'}},{...dto,manual:{...manualFixture,sample:'false'}}])assert.equal((await put('/screen-settings',bad)).status,400);
  assert.equal((await put('/screen-settings',dto)).status,200);
  const read:any=await(await fetch(base+'/screen-settings?year=2026',{headers})).json();assert.equal(read.manual.overdueCents,18600000);assert.equal(read.revision,1);
  assert.equal((await put('/screen-settings',dto)).status,409);
  assert.equal((await fetch(base+'/screen-settings?year=2026&communityIds=2',{headers})).status,403);
  const target={year:2026,communityIds:[1],feeCode:'property',annualCents:1200000,monthCents:Array(12).fill(100000)};
  assert.equal((await put('/screen-targets',{...target,communityIds:[2]})).status,403);
  assert.equal((await put('/screen-targets',{...target,annualCents:1200001})).status,400);
  assert.equal((await put('/screen-targets',{...target,annualCents:1e20,monthCents:Array(12).fill(1e20)})).status,400);
  assert.equal((await put('/screen-targets',target)).status,200);
  const reread:any=await(await fetch(base+'/screen-settings?year=2026',{headers})).json();assert.equal(reread.targets[0].annualCents,1200000);
 }finally{await app.close();await f.pg.close();}
});
