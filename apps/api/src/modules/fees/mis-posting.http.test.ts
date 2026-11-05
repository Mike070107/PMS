import 'reflect-metadata';import assert from 'node:assert/strict';import test from 'node:test';import {Module,ValidationPipe} from '@nestjs/common';import {NestFactory} from '@nestjs/core';import {MisPostingController} from './mis-posting.controller';import {MisPostingService} from './mis-posting.service';import {JwtAuthGuard} from '../auth/jwt-auth.guard';import {PermissionsGuard} from '../access/permissions.guard';import {AccessService} from '../access/access.service';
test('isolated Nest HTTP keeps real fee permissions, validates runtime DTO and never accepts a browser collector',async()=>{
 let calls=0,last:any;const target={create:async(d:any,u:any,a:any)=>{calls++;last={d,u,a};return{id:19}},detail:async()=>({id:19,amountCents:12345}),readiness:()=>({enabled:false})};const access:any={hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission};
 @Module({controllers:[MisPostingController],providers:[{provide:MisPostingService,useValue:target},JwtAuthGuard,PermissionsGuard,{provide:AccessService,useValue:access}]})class TestModule{}
 const app=await NestFactory.create(TestModule,{logger:false});const inject=(ctx:any)=>{const req=ctx.switchToHttp().getRequest(),edit=req.headers['x-test-permission']==='edit';req.user={id:7,tenantId:1};req.access={scopeAll:false,communityIds:[10],pages:{fees:{view:true,edit,delete:false}}};return true};
 for(const mod of (app as any).container.getModules().values())for(const map of [mod.providers,mod.injectables])for(const wrapper of map.values())if(wrapper.instance instanceof JwtAuthGuard)wrapper.instance.canActivate=inject;
 app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.listen(0,'127.0.0.1');const url=await app.getUrl();
 const payload={houseId:11,billIds:['900719925474099991'],amountCents:12345,paymentMethod:'cash',confirmed:true,idempotencyKey:'123e4567-e89b-42d3-a456-426614174000'};
 const send=(data:any,permission='edit')=>fetch(url+'/fees/mis/postings',{method:'POST',headers:{'Content-Type':'application/json','x-test-permission':permission},body:JSON.stringify(data)});
 try{let r=await send(payload);assert.equal(r.status,201);const body=await r.text();assert.ok(body,'收款入口必须返回持久办理单');assert.equal(JSON.parse(body).amountCents,12345);assert.equal(last.u.id,7);assert.deepEqual(last.a.communityIds,[10]);assert.equal(last.d.houseId,11);
 assert.equal((await send(payload,'view')).status,403);assert.equal(calls,1);
 assert.equal((await fetch(url+'/fees/mis/postings/19/retry',{method:'POST',headers:{'x-test-permission':'view'}})).status,403);
 for(const patch of [{confirmed:false},{amountCents:-1},{houseId:null},{billIds:[123]},{billIds:['1','1']},{paymentMethod:'现金'},{idempotencyKey:'bad'}])assert.equal((await send({...payload,...patch})).status,400,JSON.stringify(patch));assert.equal(calls,1);
 r=await send({...payload,collectorId:'ARBITRARY',collectorName:'other'});if(r.ok){assert.equal(last.d.collectorId,undefined);assert.equal(last.d.collectorName,undefined)}else assert.equal(r.status,400);
 assert.equal((await fetch(url+'/fees/mis/postings/1e0',{headers:{'x-test-permission':'edit'}})).status,400);
 }finally{await app.close()}
});
