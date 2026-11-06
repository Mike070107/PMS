import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ObservabilityController } from './observability.controller';
import { ObservabilityService } from './observability.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';

// 只注册目标类；不加载 AppModule、ConfigModule、.env 或数据库连接。
test('真实HTTP验证日志权限与分类DTO：403不调用service，非法分类400，合法分类和tenant传入', async () => {
  const calls:any[]=[];
  const service:any={list:async(user:any,query:any)=>{calls.push({user,query});return {list:[],total:0,page:query.page,pageSize:query.pageSize};}};
  const access:any={
    getAccess:async(user:any)=>({isPlatformAdmin:false,pages:{logs:{view:user.id===1,edit:false,delete:false}}}),
    hasAnyPermission:AccessService.prototype.hasAnyPermission,
    hasPermission:AccessService.prototype.hasPermission,
  };
  @Module({controllers:[ObservabilityController],providers:[
    {provide:ObservabilityService,useValue:service}, {provide:AccessService,useValue:access},JwtAuthGuard,PermissionsGuard,
  ]}) class IsolatedLogsModule {}
  const app=await NestFactory.create(IsolatedLogsModule,{logger:false});
  app.get(JwtAuthGuard).canActivate=(ctx:any)=>{const req=ctx.switchToHttp().getRequest();req.user={id:req.headers['x-denied']?2:1,tenantId:7,role:'staff'};return true;};
  app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));
  try {
    await app.listen(0,'127.0.0.1');const base=await app.getUrl();
    const denied=await fetch(base+'/observability/logs?auditClass=approval',{headers:{'x-denied':'1'}});
    assert.equal(denied.status,403);assert.equal(calls.length,0);
    const invalid=await fetch(base+'/observability/logs?auditClass=not-a-class');assert.equal(invalid.status,400);assert.equal(calls.length,0);
    const ok=await fetch(base+'/observability/logs?auditClass=approval&page=2&pageSize=30');assert.equal(ok.status,200);
    assert.equal(calls.length,1);assert.equal(calls[0].user.tenantId,7);assert.equal(calls[0].query.auditClass,'approval');assert.equal(calls[0].query.page,2);
  } finally {await app.close();}
});
