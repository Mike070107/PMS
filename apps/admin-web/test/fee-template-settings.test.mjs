import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
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
