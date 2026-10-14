import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FeesService } from './fees.service';
import { FeeTemplatesController } from './fee-templates.controller';
import { PermissionsGuard } from '../access/permissions.guard';
import { AccessService } from '../access/access.service';
import { AssignTemplateDto } from './fee-templates.dto';

test('模板接口实际权限守卫：设置查看可查询，不得修改价格或批量套用',async()=>{
  const access:any={pages:{settings:{view:true,edit:false}}};
  const guard=new PermissionsGuard(new Reflector(),Object.create(AccessService.prototype));
  const context=(method:string):any=>({getHandler:()=>FeeTemplatesController.prototype[method],getClass:()=>FeeTemplatesController,switchToHttp:()=>({getRequest:()=>({user:{id:7},access})})});
  for(const method of ['communities','list','houses','preview'])assert.equal(await guard.canActivate(context(method)),true);
  for(const method of ['create','update','disable','assign','migrate'])await assert.rejects(guard.canActivate(context(method)),/权限不足/);
  access.pages.settings.edit=true;
  assert.equal(await guard.canActivate(context('assign')),true);
});

test('批量请求必须有范围户数和价格版本，不接受字符串布尔值或越界ID',async()=>{
  const good={communityId:1,kind:'apartment',templateId:1,expectedRevision:1,expectedCount:2,all:true,effectiveFrom:'2026-10-12'};
  assert.equal((await validate(plainToInstance(AssignTemplateDto,good))).length,0);
  for(const bad of [{...good,expectedCount:undefined},{...good,expectedRevision:undefined},{...good,all:'true'},{...good,houseIds:[-1]}])assert.ok((await validate(plainToInstance(AssignTemplateDto,bad))).length);
});

test('正式收费服务校验报价并保存模板快照，报价变化时不写收费记录',async()=>{
  const service:any=Object.create(FeesService.prototype);
  service.requireTenant=()=>1;service.resolveHousePlace=async()=>({communityId:1,communityName:'馨香臣寓吴泾店'});service.assertCommunityInScope=()=>{};
  service.operatorName=async()=> '测试收费员';service.saveCashierContact=async()=>null;
  const snapshot={assignment_id:12,template_id:3,version:2,effective_from:'2026-10-12',items:[{feeCode:'rent',amountCents:90000}]};
  service.feeTemplates={resolve:async()=>snapshot};
  let saved:any[]=[];let lock=false;
  const manager={query:async(sql:string)=>{lock=true;return sql.includes('MAX(receipt_no)')?[{maxNo:null}]:[];},create:(_:any,row:any)=>row,save:async(_:any,rows:any[])=>{saved=rows;}};
  service.dataSource={transaction:async(fn:any)=>fn(manager)};
  const dto:any={houseId:101,paymentMethod:'cash',rateQuote:'12:3:1',items:[{feeCode:'rent',quantity:1,unit:'月',unitPriceCents:90000,amountCents:90000}]};
  await assert.rejects(service.createCashierCharge(dto,{id:7,tenantId:1}),/模板或住户调整已变化/);
  assert.equal(saved.length,0);assert.equal(lock,true);
  const result=await service.createCashierCharge({...dto,rateQuote:'12:3:2'},{id:7,tenantId:1});
  assert.equal(result.amountCents,90000);assert.equal(saved[0].legacyPayload.feeTemplate.version,2);
  assert.equal(saved[0].legacyPayload.feeTemplate.assignmentId,12);
});

test('公寓凭证号即收费订单号：PZ+门店全称首字母+6位日期+4位当日流水',async()=>{
  const service:any=Object.create(FeesService.prototype);
  const manager={query:async()=>[{maxNo:'PZXXCYWJD2610140027'}]};
  const paidAt=new Date('2026-10-14T03:45:00.000Z');
  assert.equal(await service.nextCashierVoucherNo(manager,1,20,'馨香臣寓吴泾店',paidAt),'PZXXCYWJD2610140028');
});

test('当日流水超过9999后自然扩位，不停止收费',async()=>{
  const service:any=Object.create(FeesService.prototype);
  const manager={query:async()=>[{maxNo:'PZXXCYWJD2610149999'}]};
  const paidAt=new Date('2026-10-14T03:45:00.000Z');
  assert.equal(await service.nextCashierVoucherNo(manager,1,20,'馨香臣寓吴泾店',paidAt),'PZXXCYWJD26101410000');
});
