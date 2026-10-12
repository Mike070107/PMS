import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const ts=createRequire(new URL('../../api/package.json',import.meta.url))('typescript');
const feeExports={};
vm.runInNewContext(ts.transpileModule(read('../../../packages/shared-types/src/fees.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:feeExports});
test('实收金额反推数量：200元按0.8元计算250度，循环小数保留3位且不改金额',()=>{
 assert.equal(typeof feeExports.cashierQuantityFromAmount,'function');
 assert.equal(feeExports.cashierQuantityFromAmount(20000,80),250);
 assert.equal(feeExports.cashierQuantityFromAmount(20000,120),166.667);
 assert.equal(feeExports.cashierQuantityFromAmount(20000,300),66.667);
 assert.equal(feeExports.cashierQuantityFromAmount(-20000,80),250);
 assert.equal(feeExports.cashierQuantityFromAmount(0,80),0);
 for(const price of [0,-80,NaN,Infinity])assert.equal(feeExports.cashierQuantityFromAmount(20000,price),null);
 assert.equal(feeExports.cashierQuantityFromAmount(NaN,80),null);
});
test('小程序真实输入处理器同步数量文字、实收、合计，改数量仍可正向计算',()=>{
 let page;
 vm.runInNewContext(ts.transpileModule(read('../../miniapp-staff/miniprogram/pages/apartment-cashier/apartment-cashier.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
  exports:{},Page:value=>{page=value;},require:name=>name==='@pms/shared-types'?feeExports:name==='@pms/api-client'?{apartmentCashier:{}}:name.endsWith('/guide')?{guideHandlers:()=>({})}:{},wx:{},
 });
 const context={...page,data:{...page.data,rows:[{feeCode:'electricity',feeName:'电费',quantity:1,quantityText:'1',unitPriceYuan:'0.80',amountYuan:'0.80',amountCents:80}]},setData(values){this.data={...this.data,...values};}};
 const input=(field,value)=>context.onRowInput({currentTarget:{dataset:{code:'electricity',field}},detail:{value}});
 input('amountYuan','200');
 assert.equal(context.data.rows[0].quantity,250);assert.equal(context.data.rows[0].quantityText,'250');assert.equal(context.data.rows[0].amountYuan,'200');assert.equal(context.data.totalCents,20000);
 input('unitPriceYuan','1.20');input('amountYuan','200');
 assert.equal(context.data.rows[0].quantity,166.667);assert.equal(context.data.rows[0].amountCents,20000);
 input('quantityText','10');assert.equal(context.data.rows[0].amountCents,1200);
 input('amountYuan','');assert.equal(context.data.rows[0].quantity,0);assert.equal(context.data.totalCents,0);
 input('unitPriceYuan','0');input('amountYuan','200');assert.equal(context.data.rows[0].quantity,0);assert.equal(context.data.rows[0].amountCents,20000);
});
test('正式系统设置复用收费模板，不再读取全公司房产选项',()=>{
 const page=read('../src/pages/FeesPage.tsx');
 const panel=page.slice(page.indexOf('export function FeeStandardsPanel()'),page.indexOf('export function FeeStandardsPanel()')+180);
 assert.match(panel,/<FeeTemplateSettings/);
 const templates=read('../src/pages/FeeTemplateSettings.tsx');
 assert.doesNotMatch(templates,/useHouseOptions|\/properties\/houses/);
 assert.match(templates,/communities\.filter\(c=>c\.kind===kind\)/);
 assert.match(templates,/url:'\/fees\/templates\/houses',query:\{\.\.\.scope/);
 assert.match(templates,/run!==sequence\.current/);
 assert.match(templates,/expectedRevision:template\.revision,expectedCount:assignment\.count/);
 assert.match(templates,/fingerprint:legacy\.fingerprint/);
});
test('Web和员工端收费提交报价版本，切换房号忽略旧响应',()=>{
 const web=read('../src/pages/ApartmentCashierPage.tsx');
 const mini=read('../../miniapp-staff/miniprogram/pages/apartment-cashier/apartment-cashier.ts');
 assert.match(web,/if\(!cancelled\).*setRateQuote/);
 assert.match(web,/houseId: house\.id,\s*rateQuote,/);
 assert.match(mini,/requestId!==this\.ratesRequest/);
 assert.match(mini,/rateQuote: this\.rateQuote/);
});
