import 'reflect-metadata';import test from 'node:test';import assert from 'node:assert/strict';import {Module,ValidationPipe} from '@nestjs/common';import {NestFactory} from '@nestjs/core';import {BusinessLedgerController} from './business-ledger.controller';import {BusinessLedgerService} from './business-ledger.service';import {JwtAuthGuard} from '../auth/jwt-auth.guard';import {PermissionsGuard} from '../access/permissions.guard';import {AccessService} from '../access/access.service';
import { resolveBusinessAction } from '../observability/business-action';
test('ledger HTTP keeps business view permission, forwards scope, validates bounded server paging',async()=>{
 let calls=0,last:any;const service={list:async(q:any,u:any,a:any)=>{calls++;last={q,u,a};return{rows:[],total:0,page:1,pageSize:q.pageSize||20}}},access:any={hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission};
 @Module({controllers:[BusinessLedgerController],providers:[{provide:BusinessLedgerService,useValue:service},JwtAuthGuard,PermissionsGuard,{provide:AccessService,useValue:access}]})class TestModule{}
 const app=await NestFactory.create(TestModule,{logger:false});for(const mod of (app as any).container.getModules().values())for(const map of [mod.providers,mod.injectables])for(const w of map.values())if(w.instance instanceof JwtAuthGuard)w.instance.canActivate=(ctx:any)=>{const r=ctx.switchToHttp().getRequest();r.user={id:7,tenantId:1};r.access={scopeAll:false,communityIds:[10],pages:{business:{view:r.headers['x-test-view']==='yes',edit:false,delete:false}}};return true};app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));await app.listen(0,'127.0.0.1');const url=(await app.getUrl())+'/business/transaction-ledger';
 try{assert.equal((await fetch(url)).status,403);let r=await fetch(url+'?page=2&pageSize=50',{headers:{'x-test-view':'yes'}});assert.equal(r.status,200);const text=await r.text();assert.ok(text,'流水端点必须返回分页结果');assert.equal(JSON.parse(text).pageSize,50);assert.equal(last.q.page,2);assert.equal(last.u.tenantId,1);assert.deepEqual(last.a.communityIds,[10]);
 for(const query of ['pageSize=500','page=-1','status=unknown','serviceType=unknown','from=2026-02-30'])assert.equal((await fetch(url+'?'+query,{headers:{'x-test-view':'yes'}})).status,400,query);assert.equal(calls,1);
 }finally{await app.close()}
});

test('parking reversal requires fees edit and forwards the validated reason and tenant scope',async()=>{
 const calls:any[][]=[];
 const service={reverseParkingPayment:async(...args:any[])=>{calls.push(args);return {reversalTxnNo:'PKR-9',amountCents:-75000};}};
 const access={hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission};
 @Module({controllers:[BusinessLedgerController],providers:[{provide:BusinessLedgerService,useValue:service},JwtAuthGuard,PermissionsGuard,{provide:AccessService,useValue:access}]})class TestModule{}
 const app=await NestFactory.create(TestModule,{logger:false});
 for(const mod of (app as any).container.getModules().values())for(const map of [mod.providers,mod.injectables])for(const w of map.values())if(w.instance instanceof JwtAuthGuard)w.instance.canActivate=(ctx:any)=>{
  const req=ctx.switchToHttp().getRequest();
  req.user={id:7,tenantId:1};req.access={scopeAll:false,communityIds:[10],pages:{business:{view:true,edit:true},fees:{view:true,edit:req.headers['x-test-fees-edit']==='yes'}}};
  return true;
 };
 app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));await app.listen(0,'127.0.0.1');
 const url=(await app.getUrl())+'/business/transaction-ledger/9/reverse';
 const post=(reason:string,edit:boolean)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-test-fees-edit':edit?'yes':'no'},body:JSON.stringify({reason})});
 try{
  assert.equal((await post('重复登记',false)).status,403);
  assert.equal((await post('  ',true)).status,400);
  assert.equal(calls.length,0);
  const accepted=await post('重复登记',true);
  assert.equal(accepted.status,201);
  assert.deepEqual(await accepted.json(),{reversalTxnNo:'PKR-9',amountCents:-75000});
  assert.equal(calls[0][0],9);assert.equal(calls[0][1],'重复登记');
  assert.equal(calls[0][2].tenantId,1);assert.deepEqual(calls[0][3].communityIds,[10]);
  const action=resolveBusinessAction('POST','/business/transaction-ledger/9/reverse');
  assert.equal(action.known,true);
  assert.equal(action.label,'红冲停车收款原流水');
 }finally{await app.close();}
});
