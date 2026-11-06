import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiEnvelope } from './envelope';
import { diagnosticRequestPath } from './request-diagnostic';
import {configure,request} from './request';
for(const transport of ['fetch','wx'])test(`${transport}:旧账号迟到401不得清除新账号会话`,async()=>{
 const previousFetch=globalThis.fetch,previousWx=(globalThis as any).wx;
 let token='synthetic-account-A',cleared=0,finish!:(response:any)=>void;
 try{
  configure({baseURL:'https://fixture.invalid/api',getToken:()=>token,onUnauthorized:()=>{cleared++}});
  if(transport==='fetch'){delete (globalThis as any).wx;globalThis.fetch=(()=>new Promise(r=>{finish=r})) as any}
  else (globalThis as any).wx={request:(opts:any)=>{finish=()=>opts.success({statusCode:401,data:{message:'expired'}})}};
  const pending=request({url:'/auth/ui-preferences'});token='synthetic-account-B';finish(new Response('{"message":"expired"}',{status:401}));
  await assert.rejects(pending,(e:any)=>e.code===401);assert.equal(cleared,0,'旧账号401不能触发当前账号登出');
 }finally{globalThis.fetch=previousFetch;if(previousWx===undefined)delete (globalThis as any).wx;else (globalThis as any).wx=previousWx}
});
test('当前账号401仍触发登出，匿名401不登出',async()=>{
 const previous=globalThis.fetch,previousWx=(globalThis as any).wx;let cleared=0;
 try{delete (globalThis as any).wx;configure({baseURL:'https://fixture.invalid/api',getToken:()=> 'synthetic-current',onUnauthorized:()=>{cleared++}});globalThis.fetch=(async()=>new Response('{}',{status:401})) as any;
 await assert.rejects(request({url:'/auth/ui-preferences'}));assert.equal(cleared,1);await assert.rejects(request({url:'/auth/admin-login',anonymous:true}));assert.equal(cleared,1);
 }finally{globalThis.fetch=previous;if(previousWx===undefined)delete (globalThis as any).wx;else (globalThis as any).wx=previousWx}
});

/**
 * 这条口径判错一次，用户看到的是红字报错、而数据其实已经存进去了 ——
 * 比真失败更难查：他会一直重试，我们从日志上只看到一串成功的 PATCH。
 * unwrap()（request.ts）完全按这个判定走：不是包装就原样返回。
 */

test('业务对象里的 code 不是响应码：材料 SKU 的编码就叫 code', () => {
  // 2026-09-01 实际现象：编辑材料点保存弹「请求失败」，但库里已经改了
  assert.equal(isApiEnvelope({ id: 12, code: 'WJ-0010', name: '球阀', spec: 'DN20' }), false);
});

test('字典项 / 定额项同样带 code，一并不能误判', () => {
  assert.equal(isApiEnvelope({ id: 1, code: 'REPAIR_TYPE', label: '报修类型' }), false);
  assert.equal(isApiEnvelope({ id: 2, code: 'QD-001', name: '墙面刷白' }), false);
});

test('真的包装还认得出来', () => {
  assert.equal(isApiEnvelope({ code: 0, data: { id: 1 } }), true);
  assert.equal(isApiEnvelope({ code: 1001, message: '余额不足' }), true);
  assert.equal(isApiEnvelope({ code: 500, data: null }), true);
});

test('裸返回照原样过：数组、null、没有 code 的对象', () => {
  assert.equal(isApiEnvelope([{ code: 'WJ-0010' }]), false);
  assert.equal(isApiEnvelope(null), false);
  assert.equal(isApiEnvelope({ id: 1, name: '张三' }), false);
  // 数字 code 但既没 data 也没 message：不像包装，按业务对象放行
  assert.equal(isApiEnvelope({ id: 3, code: 200 }), false);
});

test('异常反馈保留排障参数但不记录搜索词', () => {
  assert.equal(
    diagnosticRequestPath('/work-orders', {
      scope: 'dispatch',
      status: 'created',
      q: '枫桦景苑 303',
    } as any),
    '/work-orders?scope=dispatch&status=created',
  );
});
