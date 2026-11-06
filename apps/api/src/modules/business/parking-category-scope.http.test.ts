import 'reflect-metadata';
import test from 'node:test';import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';import { NestFactory } from '@nestjs/core';
import { BusinessController } from './business.controller';import { BusinessService } from './business.service';import { BusinessExecutionService } from './business-execution.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';import { PermissionsGuard } from '../access/permissions.guard';import { AccessService } from '../access/access.service';
test('收费小区目录HTTP只需business查看权限，保持租户/范围且不授予房产页权限',async()=>{
 const service:any=Object.create(BusinessService.prototype);service.communityRepo={find:async()=>[{id:1,name:'测试一期'},{id:2,name:'测试二期'}]};
 const access:any={hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission};
 @Module({controllers:[BusinessController],providers:[{provide:BusinessService,useValue:{feeCommunities:service.feeCommunities.bind(service)}},{provide:BusinessExecutionService,useValue:{}},JwtAuthGuard,PermissionsGuard,{provide:AccessService,useValue:access}]})class Fixture{}
 const app=await NestFactory.create(Fixture,{logger:false});
 for(const m of (app as any).container.getModules().values())for(const map of [m.providers,m.injectables])for(const w of map.values())if(w.instance instanceof JwtAuthGuard)w.instance.canActivate=(ctx:any)=>{const r=ctx.switchToHttp().getRequest();r.user={id:7,tenantId:91};r.access={scopeAll:false,communityIds:[2],pages:{business:{view:r.headers['x-view']==='yes',edit:false,delete:false}}};return true;};
 await app.listen(0,'127.0.0.1');try{const url=(await app.getUrl())+'/business/communities';assert.equal((await fetch(url)).status,403);const r=await fetch(url,{headers:{'x-view':'yes'}});assert.equal(r.status,200);assert.deepEqual(await r.json(),[{id:2,name:'测试二期'}]);}finally{await app.close();}
});
