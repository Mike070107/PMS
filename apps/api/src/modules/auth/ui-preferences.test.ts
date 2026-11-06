import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMetadataArgsStorage } from 'typeorm';
import { AuthService } from './auth.service';
import { ValidationPipe } from '@nestjs/common';
import { UpdateUiPreferencesDto, normalizeUiPreferences, UI_THEMES } from './ui-preferences.dto';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { GUARDS_METADATA } from '@nestjs/common/constants';
test('个人外观路由必须保留JWT鉴权，配置不接受CSS或任意字符串',async()=>{
 for(const key of ['getUiPreferences','saveUiPreferences'])assert.ok(Reflect.getMetadata(GUARDS_METADATA,(AuthController.prototype as any)[key]).includes(JwtAuthGuard));
 const pipe=new ValidationPipe({transform:true,whitelist:true});
 for(const value of [{theme:null},{theme:'red'},{theme:'url(https://example.com)'},{sidebarCollapsed:null},{sidebarCollapsed:'true'},{sidebarCollapsed:1}])await assert.rejects(pipe.transform(value,{type:'body',metatype:UpdateUiPreferencesDto}));
 for(const theme of UI_THEMES)assert.equal((await pipe.transform({theme,userId:99},{type:'body',metatype:UpdateUiPreferencesDto})).theme,theme);
 assert.equal((await pipe.transform({theme:'jade',userId:99},{type:'body',metatype:UpdateUiPreferencesDto})).userId,undefined);
 assert.deepEqual(normalizeUiPreferences({theme:'retired',sidebarCollapsed:null}),{theme:'slate',sidebarCollapsed:false});
});
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import { User } from '../../entities/user.entity';
async function fixture(){
 const pg=new PGlite(),ds=new DataSource({type:'postgres',entities:[User],synchronize:false});await (ds as any).buildMetadatas();
 ds.createQueryRunner=(()=>{const qr:any={connection:ds,isReleased:false,isTransactionActive:false,data:{},connect:async()=>{},release:async()=>{},query:async(sql:string,p:any[]=[],structured=false)=>{const out=await pg.query(sql,p);if(!structured)return out.rows;const r=new QueryResult();r.records=out.rows;r.raw=out.rows;r.affected=out.affectedRows;return r}};qr.broadcaster=new Broadcaster(qr);qr.manager=ds.createEntityManager(qr);return qr}) as any;
 (ds as any).isInitialized=true;
 await pg.exec(`CREATE TABLE users(id serial PRIMARY KEY,tenant_id int,status varchar(20) NOT NULL DEFAULT 'active',updated_at timestamptz DEFAULT now(),updated_by int,ui_preferences jsonb NOT NULL DEFAULT '{}');INSERT INTO users(id,tenant_id) VALUES(1,10),(2,10),(3,20),(4,NULL)`);
 const service:any=Object.create(AuthService.prototype);service.userRepo=ds.getRepository(User);return {pg,service};
}
test('真实TypeORM/PGlite保存后重新读取，其他用户和管理处视角不受影响',async()=>{
 const f=await fixture();try{
  assert.equal(typeof f.service.getUiPreferences,'function','缺少个人偏好读取能力');
  assert.deepEqual(await f.service.getUiPreferences(1),{theme:'slate',sidebarCollapsed:false});
  await f.service.saveUiPreferences(1,{theme:'jade'});
  const reopened:any=Object.create(AuthService.prototype);reopened.userRepo=f.service.userRepo;
  assert.equal((await reopened.getUiPreferences(1)).theme,'jade');
  for(const id of [2,3,4])assert.equal((await reopened.getUiPreferences(id)).theme,'slate');
  await f.service.saveUiPreferences(4,{theme:'sand'});assert.equal((await reopened.getUiPreferences(4)).theme,'sand');
  const rows=await f.pg.query('SELECT id,tenant_id,ui_preferences FROM users ORDER BY id');assert.deepEqual(rows.rows.map((r:any)=>r.tenant_id),[10,10,20,null]);
 }finally{await f.pg.close()}
});
test('同时保存主题与菜单偏好不会互相覆盖或修改其他账号',async()=>{
 const f=await fixture();try{
  await Promise.all([f.service.saveUiPreferences(1,{theme:'ocean'}),f.service.saveUiPreferences(1,{sidebarCollapsed:true}),f.service.saveUiPreferences(2,{theme:'rose'})]);
  assert.deepEqual(await f.service.getUiPreferences(1),{theme:'ocean',sidebarCollapsed:true});assert.equal((await f.service.getUiPreferences(2)).theme,'rose');
  await f.pg.query(`UPDATE users SET ui_preferences=ui_preferences||'{"futureOption":true}' WHERE id=1`);
  await f.service.saveUiPreferences(1,{theme:'indigo'});assert.equal(((await f.pg.query('SELECT ui_preferences FROM users WHERE id=1')).rows[0] as any).ui_preferences.futureOption,true);
  await assert.rejects(f.service.saveUiPreferences(999,{theme:'jade'}));
 }finally{await f.pg.close()}
});
test('个人界面偏好保存在用户记录而不是租户全局配置',()=>{
 const col=getMetadataArgsStorage().columns.find(c=>c.target===User&&c.propertyName==='uiPreferences');
 assert.ok(col,'用户实体必须有个人界面偏好字段');
 assert.equal(col.options.name,'ui_preferences');assert.equal(col.options.type,'jsonb');
});
