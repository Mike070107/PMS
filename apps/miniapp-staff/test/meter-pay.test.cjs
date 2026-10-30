const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const {createRequire}=require('node:module');const apiRequire=createRequire(path.resolve(__dirname,'../../api/package.json'));
const ts=apiRequire('typescript');
const source=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/meter-detail/meter-detail.ts'),'utf8');
function fixture({pay=async()=>({}),storage=new Map(),canPay=true}={}) {
 let definition;let requests=[];let refreshed=0;
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),pageScrollTo:()=>{},showToast:()=>{}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{
  exports:{},Page:x=>definition=x,wx,console,require:name=>name==='@pms/api-client'?{meters:{payCharge:async(id,payload)=>{requests.push({id,payload});return pay(id,payload);}}}:name.endsWith('/meter')?{meterErrText:e=>e.message,formatMeterTime:x=>x}:{}
 });
 const row={id:9,status:'unpaid',outstandingCents:4200,outstandingYuan:'42.00',receivableYuan:'42.00',paidYuan:'0.00',period:'2026-10'};
 const page={...definition,data:{...definition.data,canPay,payScope:'meter-pay:1:7',detail:{charges:[row]}},setData(x,callback){Object.assign(this.data,x);callback?.();},load:async()=>{refreshed++;}};
 return {page,storage,requests,get refreshed(){return refreshed;},open:()=>page.onOpenPay({currentTarget:{dataset:{id:9}}})};
}
test('小程序收款：空金额与方式同时就近报错，修正方式只清本字段',async()=>{
 const f=fixture();f.open();f.page.data.payAmount='';await f.page.onSubmitPay();assert.ok(f.page.data.payAmountError);assert.ok(f.page.data.payMethodError);assert.equal(f.page.data.payAmountFocus,true);assert.equal(f.requests.length,0);
 f.page.onPayMethod({currentTarget:{dataset:{value:'wechat'}}});assert.equal(f.page.data.payMethodError,'');assert.ok(f.page.data.payAmountError);
});
test('小程序收款：只有抄表权限不能开收款或提交；超额金额拦截',async()=>{
 const f=fixture({canPay:false});f.open();assert.equal(f.page.data.payTarget,null);await f.page.onSubmitPay();assert.equal(f.requests.length,0);
 const g=fixture();g.open();g.page.data.payAmount='42.01';g.page.data.payMethod='cash';await g.page.onSubmitPay();assert.match(g.page.data.payAmountError,/最多/);assert.equal(g.requests.length,0);
});
test('小程序收款：超时保留原资料与请求编号，重新进入按同一笔重试并刷新',async()=>{
 const f=fixture({pay:async()=>{throw Error('网络超时');}});f.open();f.page.data.payAmount='10.00';f.page.data.payMethod='wechat';f.page.data.payNote='部分收款';await f.page.onSubmitPay();
 assert.equal(f.page.data.payPending,true);assert.equal(f.page.data.payAmount,'10.00');assert.match(f.page.data.payError,/超时/);
 const g=fixture({storage:f.storage});g.open();assert.equal(g.page.data.payPending,true);assert.equal(g.page.data.payMethod,'wechat');
 g.page.onPayField({currentTarget:{dataset:{field:'payAmount'}},detail:{value:'20'}});assert.equal(g.page.data.payAmount,'10.00');await g.page.onSubmitPay();
 assert.equal(g.requests[0].payload.clientRequestId,f.requests[0].payload.clientRequestId);assert.equal(g.requests[0].payload.amountCents,1000);assert.equal(g.storage.size,0);assert.equal(g.refreshed,1);assert.equal(g.page.data.payTarget,null);
});
test('小程序收款：提交中重复点击只有一次请求，明确拒绝可修改后再登记',async()=>{
 let resolve;const f=fixture({pay:()=>new Promise(r=>resolve=r)});f.open();f.page.data.payMethod='cash';const waiting=f.page.onSubmitPay();await f.page.onSubmitPay();assert.equal(f.requests.length,1);resolve({});await waiting;
 const g=fixture({pay:async()=>{throw Object.assign(Error('金额超过待收'),{httpStatus:400});}});g.open();g.page.data.payMethod='cash';await g.page.onSubmitPay();assert.equal(g.page.data.payPending,false);assert.equal(g.storage.size,0);assert.equal(g.page.data.payMethod,'cash');
});
