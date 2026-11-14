import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const ts=createRequire(new URL('../../api/package.json',import.meta.url))('typescript');
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const shared={};vm.runInNewContext(ts.transpileModule(read('../../../packages/shared-types/src/fees.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:shared});
function fixture(api={},session={canSeeCashier:true,canCharge:true,me:{id:1,tenantId:7,access:{communityIds:[3]}}},storage=new Map()){
 let page;const charges=[],toasts=[];
 const cashier={communities:async()=>[{id:3,name:'甲公寓'}],buildings:async()=>[],history:async()=>({rows:[]}),charge:async p=>{charges.push(p);return{receiptNo:'SYNTHETIC-APARTMENT'}},...api};
 vm.runInNewContext(ts.transpileModule(read('../miniprogram/pages/apartment-cashier/apartment-cashier.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:{},Page:p=>page=p,require:n=>n==='@pms/shared-types'?shared:n==='@pms/api-client'?{apartmentCashier:cashier}:n.endsWith('/session')?{getSession:async()=>session}:n.endsWith('/guide')?{guideHandlers:()=>({})}:n.endsWith('/tabbar')?{rememberAccess(){},syncTabBar(){}}:{},wx:{getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),showToast:o=>toasts.push(o),showModal:async()=>({confirm:true})}});
 page.data=JSON.parse(JSON.stringify(page.data));page.setData=p=>Object.assign(page.data,p);
 Object.assign(page.data,{canCharge:true,houses:[{id:42,buildingNo:'1',roomNo:'101'}],houseIndex:0,placeText:'1号-101室',paymentMethod:'cash'});
 return{page,charges,storage,toasts};
}
const toggle=(p,code)=>p.onToggleFee({currentTarget:{dataset:{code}}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
test('Q1草稿重读Q2不能换新报价继续收旧价，失败后成功重读也必须重新添加',async()=>{
 for(const firstFails of [false,true]){
  let version=1,fail=false;const f=fixture({standards:async()=>{if(fail)throw Error('合成读取失败');return{rateQuote:'quote-'+version,standards:[{feeCode:'rent',status:'active',amountCents:version===1?100000:200000,unit:'月'}]}}});
  await f.page.loadRates(42);toggle(f.page,'rent');version=2;
  if(firstFails){fail=true;await f.page.onRetryRates();fail=false;}
  await f.page.onRetryRates();assert.equal(f.page.data.rows.length,0,'新报价不得冒充旧草稿对应标准');assert.match(f.page.data.ratesError,/重新.*选择|重新.*添加/);await f.page.onSubmit();assert.equal(f.charges.length,0);
  toggle(f.page,'rent');assert.equal(f.page.data.rows[0].amountCents,200000);await f.page.onSubmit();assert.equal(f.charges[0].rateQuote,'quote-2');assert.equal(f.charges[0].items[0].amountCents,200000);
 }
});
test('按面积的房间总额不冒充每平方米单价，按用量采用模板单位',async()=>{
 const{page}=fixture({standards:async()=>({rateQuote:'1:2:3',standards:[{feeCode:'management',status:'active',amountCents:20000,unit:'㎡',calculation:'area',cycle:'month'},{feeCode:'hot_water',status:'active',amountCents:1800,unit:'立方米',calculation:'quantity',cycle:'once'}]})});await page.loadRates(42);toggle(page,'management');toggle(page,'hot_water');
 assert.match(page.data.rows[0].priceHint,/面积.*已计算/);assert.equal(page.data.rows[0].unit,'月');assert.equal(page.data.rows[0].amountCents,20000);assert.equal(page.data.rows[1].unit,'立方米');
 page.onRowInput({currentTarget:{dataset:{code:'hot_water',field:'quantityText'}},detail:{value:'2.5'}});assert.equal(page.data.rows[1].amountCents,4500);
});
test('停车缺车牌或日期倒置不提交，失败保留停车输入',async()=>{
 for(const details of [{vehiclePlate:'',serviceFrom:'2026-11-14',serviceTo:'2026-12-13'},{vehiclePlate:'沪A00001',serviceFrom:'2026-02-30',serviceTo:'2026-12-13'},{vehiclePlate:'沪A00001',serviceFrom:'2026-11-14',serviceTo:'2026-11-13'}]){
  const f=fixture();f.page.rateQuote=null;f.page.data.rows=[{feeCode:'parking',feeName:'停车费',unit:'月',quantity:1,unitPriceYuan:'300.00',amountCents:30000,...details}];await f.page.onSubmit();assert.equal(f.charges.length,0);assert.match(f.page.data.submitError,/日期|车牌/);
 }
 const f=fixture({charge:async()=>{throw Error('合成写入失败')}});f.page.rateQuote=null;f.page.data.rows=[{feeCode:'parking',feeName:'停车费',unit:'月',quantity:1,unitPriceYuan:'300.00',amountCents:30000,vehiclePlate:'沪A00001',serviceFrom:'2026-11-14',serviceTo:'2026-12-13'}];const before=JSON.stringify(f.page.data.rows);await f.page.onSubmit();assert.equal(JSON.stringify(f.page.data.rows),before);assert.equal(f.page.data.receiptOpen,false);assert.match(f.page.data.submitError,/合成写入失败/);
});
test('所属单一公寓自动选，多范围记住本人选择但不使用已失效范围',async()=>{
 const directories=[{id:3,name:'甲公寓'},{id:4,name:'乙公寓'},{id:9,name:'范围外'}],storage=new Map();
 const one=fixture({communities:async()=>directories});await one.page.onLoad();assert.equal(one.page.data.communityText,'甲公寓');assert.equal(one.page.data.communities.length,1,'选择器不保留范围外公寓');
 const me={canSeeCashier:true,canCharge:true,me:{id:2,tenantId:7,access:{communityIds:[3,4]}}};
 const first=fixture({communities:async()=>directories},me,storage);await first.page.onLoad();assert.equal(first.page.data.communityIndex,-1);await first.page.pickCommunity(1);
 const again=fixture({communities:async()=>directories},me,storage);await again.page.onLoad();assert.equal(again.page.data.communityText,'乙公寓');
 const other=fixture({communities:async()=>directories},{...me,me:{...me.me,id:8}},storage);await other.page.onLoad();assert.equal(other.page.data.communityIndex,-1,'不沿用别人的默认');
 const expired=fixture({communities:async()=>directories},{...me,me:{...me.me,access:{communityIds:[3]}}},storage);await expired.page.onLoad();assert.equal(expired.page.data.communityText,'甲公寓');
});
test('停车明细的车牌与完整起止日期进入同一原项目和小票',async()=>{
 const{page,charges}=fixture({standards:async()=>({rateQuote:'1:2:3',standards:[{feeCode:'parking',status:'active',amountCents:30000}]})});await page.loadRates(42);toggle(page,'parking');
 for(const[field,value]of Object.entries({vehiclePlate:'沪A00001',serviceFrom:'2026-11-14',serviceTo:'2026-12-13'}))page.onRowInput({currentTarget:{dataset:{code:'parking',field}},detail:{value}});
 await page.onSubmit();assert.equal(charges.length,1);assert.equal(charges[0].items[0].vehiclePlate,'沪A00001');assert.equal(charges[0].items[0].serviceFrom,'2026-11-14');assert.equal(charges[0].items[0].serviceTo,'2026-12-13');
 assert.equal(page.data.receiptItems[0].vehiclePlate,'沪A00001');assert.equal(page.data.receiptItems[0].serviceFrom,'2026-11-14');assert.equal(page.data.receiptItems[0].serviceTo,'2026-12-13');
 const markup=read('../miniprogram/pages/apartment-cashier/apartment-cashier.wxml');assert.match(markup,/data-field="vehiclePlate"/);assert.match(markup,/mode="date"[^>]*data-field="serviceFrom"/);assert.match(markup,/mode="date"[^>]*data-field="serviceTo"/);
});
test('切楼栋后旧房标准不得回填，A到B乱序响应仅保留B报价',async()=>{
 const a=deferred(),b=deferred(),{page}=fixture({standards:id=>id===42?a.promise:b.promise});
 const loadA=page.loadRates(42);page.setData(page.clearedHouse());
 a.resolve({rateQuote:'old-A',standards:[{feeCode:'parking',status:'active',amountCents:1}]});await loadA;
 assert.equal(page.rateQuote,undefined,'离开房间要立即作废待返回报价');assert.equal(Object.keys(page.rates).length,0);assert.equal(page.data.ratesLoading,false);
 const first=deferred();let n=0;const f=fixture({standards:()=>++n===1?first.promise:b.promise});
 const old=f.page.loadRates(42),latest=f.page.loadRates(43);
 b.resolve({rateQuote:'new-B',standards:[{feeCode:'parking',status:'active',amountCents:50000}]});await latest;
 first.resolve({rateQuote:'old-A',standards:[{feeCode:'parking',status:'active',amountCents:1}]});await old;
 assert.equal(f.page.rateQuote,'new-B');assert.equal(f.page.rates.parking,50000);
});
test('缺标准不冒充0元，明确零价可见，读取失败可重试',async()=>{
 let fail=false;const{page}=fixture({standards:async()=>{if(fail)throw Error('合成标准读取失败');return{rateQuote:null,standards:[{feeCode:'network',status:'active',amountCents:0}]}}});
 await page.loadRates(42);toggle(page,'hot_water');assert.equal(page.data.rows.length,0,'未配置项目不得生成0元行');assert.match(page.data.ratesError,/未配置/);
 toggle(page,'network');assert.equal(page.data.rows[0].unitPriceYuan,'0.00');assert.equal(page.data.rows[0].amountYuan,'0.00');
 fail=true;await page.loadRates(42);assert.equal(page.rateQuote,undefined);assert.match(page.data.ratesError,/读取失败/);assert.equal(page.data.ratesLoading,false);
 fail=false;await page.onRetryRates();assert.equal(page.rateQuote,null);assert.match(page.data.ratesError,/重新选择/);assert.equal(page.data.rows.length,0);
});
test('标准未返回先点项目不能生成空价收费行，返回后停车和房租均带价',async()=>{
 const d=deferred(),{page}=fixture({standards:()=>d.promise});const loading=page.loadRates(42);toggle(page,'parking');
 assert.equal(page.data.rows.length,0,'加载中不得生成空单价行');
 d.resolve({rateQuote:'1:2:3',standards:[{feeCode:'parking',status:'active',amountCents:30000},{feeCode:'rent',status:'active',amountCents:150000}]});await loading;
 toggle(page,'parking');toggle(page,'rent');assert.equal(page.data.rows[0].unitPriceYuan,'300.00');assert.equal(page.data.rows[1].unitPriceYuan,'1500.00');
});
