import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const ts = requireApi('typescript');
const feeExports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../../packages/shared-types/src/fees.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:feeExports});
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../../packages/shared-types/src/beijing-time.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:feeExports});
const source = readFileSync(new URL('../miniprogram/pages/apartment-cashier/apartment-cashier.ts', import.meta.url), 'utf8');
test('公寓收费底部入口按权限展示，不再放更多；收费页复用底栏', () => {
  const rolesSource = readFileSync(new URL('../miniprogram/utils/roles.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(rolesSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  assert.equal(exports.canSeeTab('cashier', { pages: { 'app:apartment-cashier': true } }), true);
  assert.equal(exports.canSeeTab('cashier', { pages: { 'app:pool': true } }), false);
  const more = readFileSync(new URL('../miniprogram/pages/me/me.wxml', import.meta.url), 'utf8');
  assert.doesNotMatch(more, /bindtap="onOpenCashier"/);
  assert.match(readFileSync(new URL('../miniprogram/pages/apartment-cashier/apartment-cashier.wxml', import.meta.url), 'utf8'), /staff-tabbar id="cashier-tabbar"/);
});
function fixture({ confirm = true, fail = false, printApi = {}, wxOverrides = {} } = {}) {
  let page, modalCalls = 0; const charges = [];
  const shared = { ...feeExports, APARTMENT_FEE_TYPES: [{ code: 'rent', name: '房租', unit: '月' }], FEE_PAYMENT_METHOD_LABELS: { cash: '现金' },
    cashierQuantityFromAmount: (amount, price) => price > 0 ? Number((Math.abs(amount) / price).toFixed(3)) : null, formatFeeMoney: (n) => String(n / 100), buildingLabel: (n) => n, roomLabel: (n) => n, placeLabel: (b, r) => `${b}-${r}` };
  const cashier = { ...printApi, charge: async (payload) => { charges.push(payload); if (fail) throw new Error('写入失败'); return { receiptNo: 'TEST-001' }; }, history: async () => ({ rows: [], total: 0 }), today: async () => ({ rows: [], total: 0, totalCents: charges.length * 18000 }) };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: (value) => { page = value; }, require: (name) => name === '@pms/api-client' ? { apartmentCashier: cashier }
      : name === '@pms/shared-types' ? shared : name.includes('guide') ? { guideHandlers: () => ({}) } : {},
    wx: { showModal: async () => { modalCalls++; return { confirm }; }, ...wxOverrides },
  });
  page.rateQuote = null; page.data = JSON.parse(JSON.stringify(page.data)); page.setData = (patch) => Object.assign(page.data, patch);
  Object.assign(page.data, { canCharge: true, houses: [{ id: 42 }], houseIndex: 0, placeText: '13号-130室',
    paymentMethod: 'cash', rows: [{ feeCode: 'rent', feeName: '房租', unit: '月', quantity: 1, quantityText: '1', unitPriceYuan: '180', amountYuan: '180', amountCents: 18000 }], totalCents: 18000, totalText: '180', remark: '测试备注' });
  return { page, charges, modalCalls: () => modalCalls };
}
test('仅查看权限和提交中不能发起收款', async () => {
  const f = fixture(); f.page.data.canCharge = false; await f.page.onSubmit();
  f.page.data.canCharge = true; f.page.data.submitting = true; await f.page.onSubmit();
  assert.equal(f.modalCalls(), 0); assert.equal(f.charges.length, 0);
});
test('连点收款只打开一次确认、只提交一次；取消后解除锁', async () => {
  const f = fixture(); await Promise.all([f.page.onSubmit(), f.page.onSubmit()]);
  assert.equal(f.modalCalls(), 1); assert.equal(f.charges.length, 1); assert.equal(f.page.data.receiptNo, 'TEST-001');
  assert.equal(f.page.data.submitError, ''); assert.equal(f.page.data.todayLoaded, false); assert.equal(f.page.data.todayRows.length, 0);
  const cancelled = fixture({ confirm: false }); await cancelled.page.onSubmit();
  assert.equal(cancelled.charges.length, 0); assert.equal(cancelled.page.data.submitting, false); assert.equal(cancelled.page.data.rows.length, 1);
});
test('收款失败保留费用、收款方式和备注，不能显示成功小票', async () => {
  const f = fixture({ fail: true }); await f.page.onSubmit();
  assert.equal(f.page.data.rows.length, 1); assert.equal(f.page.data.paymentMethod, 'cash'); assert.equal(f.page.data.remark, '测试备注');
  assert.equal(f.page.data.receiptOpen, false); assert.match(f.page.data.submitError, /写入失败/);
});
test('手工金额提交保持实收额，不被数量乘单价覆盖', async () => {
  const f = fixture(); f.page.onRowInput({ currentTarget: { dataset: { code: 'rent', field: 'amountYuan' } }, detail: { value: '175.50' } });
  await f.page.onSubmit(); assert.equal(f.charges[0].items[0].amountCents, 17550); assert.equal(f.charges[0].items[0].unitPriceCents, 18000);
});

test('确认授权打印机才创建一张任务，补打不调用收款', async () => {
  const jobs=[];
  const f=fixture({printApi:{
    receiptPrinters:async()=>[{id:1,name:'离线',online:false},{id:2,name:'前台',online:true}],
    queueReceipt:async(...args)=>{jobs.push(args);return {id:41,state:'spooled'};}
  },wxOverrides:{showActionSheet:async({itemList})=>{assert.deepEqual([...itemList],['前台']);return {tapIndex:0};}}});
  await Promise.all([f.page.offerPrint('S-1',true),f.page.offerPrint('S-1',true)]);
  assert.equal(jobs.length,1);assert.deepEqual(jobs[0].slice(0,3),[2,'S-1',true]);assert.equal(f.charges.length,0);
});
test('收款后无打印授权或用户取消均不创建打印任务',async()=>{
  for(const printers of [[],[{id:2,name:'前台',online:true}]]){
    let sent=0;const f=fixture({confirm:false,printApi:{receiptPrinters:async()=>printers,queueReceipt:async()=>{sent++;}}});
    await f.page.offerPrint('S-2',false);assert.equal(sent,0);assert.equal(f.modalCalls(),printers.length?1:0);
  }
});test('补打重新查授权并区分撤权、离线和读取失败', async () => {
  for (const [read,title] of [
    [async()=>[], '未获打印授权'],
    [async()=>[{id:9,name:'前台',online:false}], '打印机离线'],
    [async()=>{throw Error('断网');}, '打印机列表读取失败'],
  ]) {
    const titles=[];
    const f=fixture({printApi:{receiptPrinters:read,queueReceipt:async()=>assert.fail('不得发送打印任务')},
      wxOverrides:{showModal:async m=>{titles.push(m.title);return {confirm:true};}}});
    f.page.data.printAvailable=true;
    await f.page.offerPrint('S-3',true);
    assert.ok(titles.includes(title));assert.equal(f.charges.length,0);
  }
});
test('点击单笔查看其真实明细，迟到的其他票据不能覆盖，补打仅发送当前小票号',async()=>{
  let resolveFirst;const sent=[];
  const f=fixture({printApi:{
    receipt:async no=>no==='A'?new Promise(resolve=>{resolveFirst=resolve;}):{receiptNo:'B',amountCents:3200,items:[{id:2,feeName:'电费',amountCents:3200}]},
    receiptPrinters:async()=>[{id:7,name:'前台',online:true}],queueReceipt:async(id,no,reprint)=>{sent.push([no,reprint]);return {id:2,state:'spooled'};}
  },wxOverrides:{showActionSheet:async()=>({tapIndex:0})}});
  const event=no=>({currentTarget:{dataset:{receipt:no}}});
  const first=f.page.onOpenRecord(event('A'));await f.page.onOpenRecord(event('B'));
  resolveFirst({receiptNo:'A',amountCents:100,items:[]});await first;
  assert.equal(f.page.data.recordDetail.items[0].feeName,'电费');
  await f.page.onPrintRow(event(f.page.data.recordDetail.receiptNo));
  assert.deepEqual(sent,[['B',true]]);assert.equal(f.charges.length,0);
});

test('history and today bind their trailing print button to the individual record', () => {
  const wxml=readFileSync(new URL('../miniprogram/pages/apartment-cashier/apartment-cashier.wxml',import.meta.url),'utf8');
  for(const list of ['history','todayRows']){
    const start=wxml.indexOf('wx:for="{{'+list+'}}"');
    const row=wxml.slice(start,wxml.indexOf('wx:if="{{'+list+'.length}}"',start));
    assert.match(row,/data-receipt="{{item.receiptNo}}" bindtap="onOpenRecord"/);
    const button=row.match(/<button[^>]+data-receipt="{{item.receiptNo}}" catchtap="onPrintRow"/g);
    assert.equal(button?.length,1); assert.ok(row.indexOf(button[0])>row.indexOf('{{item.amountText}}'));
  }
});

test('逐笔红冲防连点，收费打印与历史补打按入口区分', async () => {
  const wxml=readFileSync(new URL('../miniprogram/pages/apartment-cashier/apartment-cashier.wxml',import.meta.url),'utf8');
  assert.doesNotMatch(wxml,/打印本笔/);
  assert.match(wxml,/activeTab === 'charge' && placeText \? 'container--with-bar' : 'container--tabbar'/);
  assert.equal((wxml.match(/catchtap="onPrintRow" aria-label="补打"/g)||[]).length,2);
  assert.match(wxml,/bindtap="onPrintRow">补打</);
  assert.match(source,/confirmText:reprint\?'补打':'打印'/);
  let posts=0;
  const p=fixture({printApi:{
    receipt:async no=>({receiptNo:no, amountCents:no==='A'?300:-300, status:'paid',items:[]}),
    refund:async(no,reason)=>{assert.equal(no,'A');assert.equal(reason,'错收');posts++;return {receiptNo:'B',originalReceiptNo:'A',amountCents:-300};}
  }}).page;
  await p.loadRecord('A');p.beginRefund();p.onRefundReason({detail:{value:'错收'}});
  await Promise.all([p.confirmRefund(),p.confirmRefund()]);
  assert.equal(posts,1);assert.equal(p.data.recordNo,'B');
  p.beginRefund();await p.confirmRefund();assert.equal(posts,1);
  await p.loadRecord('A');p.data.canCharge=false;p.beginRefund();await p.confirmRefund();assert.equal(posts,1);
});

test('红冲响应中断后按原收据核对，已生成的红冲单可以打开', async () => {
  let written=false, posts=0;
  const p=fixture({printApi:{
    receipt:async no=>({receiptNo:no,amountCents:no==='A'?900:-900,status:written?'refunded':'paid',items:[],
      reversalReceiptNo:written && no==='A'?'R':null}),
    refund:async()=>{posts++;written=true;throw new Error('请求超时');},
  }}).page;
  await p.loadRecord('A');p.beginRefund();p.cancelRefund();await p.confirmRefund();assert.equal(posts,0);
  p.beginRefund();await p.confirmRefund();assert.equal(p.data.recordNo,'R');assert.equal(posts,1);
  await p.loadRecord('A');p.beginRefund();await p.confirmRefund();assert.equal(posts,1);
});
