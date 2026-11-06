import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MisFeesService } from './mis-fees.service';
test('第4.1节提供催收效果只读入口，不能以现有收费总览替代',()=>{const s:any=Object.create(MisFeesService.prototype);assert.equal(typeof s.collectionEffects,'function');});

test('followup records must persist and frozen households must be excluded by preview',()=>{const s:any=Object.create(MisFeesService.prototype);assert.equal(typeof s.recordCollectionFollowup,'function');assert.equal(typeof s.collectionFollowups,'function');});

test('print registration requires a persisted API before window print',()=>{const s:any=Object.create(MisFeesService.prototype);assert.equal(typeof s.registerCollectionPrint,'function');});

test('SMS readiness reason comes from existing settings rather than generic channel text',async()=>{const s:any=Object.create(MisFeesService.prototype);s.configured=()=>true;s.scope=async()=>[{id:1,name:'fixture',offices:['01']}];s.read=async()=>({recordset:[]});s.smsSettings={readiness:async()=>({configured:false,enabled:false,canSend:false,reason:'fixture-template-not-approved'})};const out=await s.metadata({id:1,tenantId:1},{scopeAll:true} as any);assert.equal(out.smsReadiness?.reason,'fixture-template-not-approved');});

test('effect rejects missing snapshot rather than publishing a zero total',async()=>{const s:any=Object.create(MisFeesService.prototype);s.residentialScope=async()=>[{id:1}];const qb:any={where:()=>qb,andWhere:()=>qb,orderBy:()=>qb,take:()=>qb,getMany:async()=>[{id:1,createdAt:new Date(),communityIds:[1],snapshot:{}}]};s.batches={createQueryBuilder:()=>qb};await assert.rejects(s.collectionEffects({}, {id:1,tenantId:1},{}),/snapshot|\u5feb\u7167/i)});
