import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CollectionSmsConfigDto } from './collection-sms.service';
test('短信配置DTO所有可选字段拒绝null（400），省略或undefined合法', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const metadata = { type: 'body' as const, metatype: CollectionSmsConfigDto };
  const fields = ['enabled', 'signName', 'templateCode', 'templateContent', 'accessKeyId', 'accessKeySecret', 'clearCredentials', 'approved', 'startHour', 'endHour', 'cooldownHours', 'dailyLimit'];
  await assert.doesNotReject(() => pipe.transform({}, metadata));
  await Promise.all(fields.map(async (field) => {
    await assert.doesNotReject(() => pipe.transform({ [field]: undefined }, metadata));
    await assert.rejects(
      () => pipe.transform({ [field]: null }, metadata),
      (error: unknown) => error instanceof BadRequestException && error.getStatus() === 400,
      `${field}: null必须返回400，而不是被当作省略`,
    );
  }));
});
const file=join(__dirname,'collection-sms.service.ts');
function fixture(){assert.ok(existsSync(file),'系统设置必须有可持久化、脱敏的催缴短信配置');const {CollectionSmsService}=require('./collection-sms.service');let row:any=null;const repo:any={findOne:async({where}:any)=>row?.tenantId===where.tenantId?row:null,createQueryBuilder:()=>{let value:any,expected:any;const qb:any={update:()=>qb,set:(v:any)=>{value=v;return qb},where:(_:any,p:any)=>{expected=p;return qb},insert:()=>qb,into:()=>qb,values:(v:any)=>{value=v;return qb},orIgnore:()=>qb,returning:()=>qb,execute:async()=>{if(expected){if(row?.tenantId!==expected.tenantId||JSON.stringify(row.value)!==expected.expected)return {affected:0};row={...row,...value};return {affected:1}}if(row?.tenantId===value.tenantId)return {raw:[]};row=value;return {raw:[{id:1}]}}};return qb}};return {service:new CollectionSmsService(repo),raw:()=>row};}
test('阿里云短信配置租户隔离、加密存储、密钥不回显，留空保持',async()=>{const old=process.env.SETTINGS_ENCRYPTION_KEY;process.env.SETTINGS_ENCRYPTION_KEY='isolated-unit-test-key-not-production';try{const f=fixture(),user={id:1,tenantId:1};const input={enabled:false,signName:'测试物业',templateCode:'SMS_123456',templateContent:'截至${date}，${address}的${period}物业费待缴${amount}元。',accessKeyId:'TESTKEY12345',accessKeySecret:'unit-test-secret-only-12345',approved:false,startHour:9,endHour:18,cooldownHours:168,dailyLimit:1};const out=await f.service.save(input,user);assert.ok(!JSON.stringify(out).includes('TESTKEY12345'));assert.ok(!JSON.stringify(out).includes('unit-test-secret-only-12345'));assert.ok(!JSON.stringify(f.raw()).includes('unit-test-secret-only-12345'));assert.equal(out.hasAccessKeySecret,true);await f.service.save({...input,accessKeyId:'',accessKeySecret:''},user);assert.equal((await f.service.get(user)).hasAccessKeySecret,true);assert.equal((await f.service.get({id:1,tenantId:2})).hasAccessKeySecret,false);assert.equal((await f.service.readiness(1)).canSend,false);}finally{if(old===undefined)delete process.env.SETTINGS_ENCRYPTION_KEY;else process.env.SETTINGS_ENCRYPTION_KEY=old;}});
test('缺加密主密钥不能明文保存，非法模板变量或倒置时段拒绝',async()=>{const old=process.env.SETTINGS_ENCRYPTION_KEY,oldJwt=process.env.JWT_SECRET;delete process.env.SETTINGS_ENCRYPTION_KEY;delete process.env.JWT_SECRET;try{const f=fixture();await assert.rejects(f.service.save({accessKeySecret:'unit-test-secret'},{id:1,tenantId:1}),/加密/);await assert.rejects(f.service.save({startHour:19,endHour:8},{id:1,tenantId:1}),/时段/);await assert.rejects(f.service.save({templateContent:'${arbitraryUrl}'},{id:1,tenantId:1}),/变量/);}finally{if(old!==undefined)process.env.SETTINGS_ENCRYPTION_KEY=old;if(oldJwt!==undefined)process.env.JWT_SECRET=oldJwt;}});
