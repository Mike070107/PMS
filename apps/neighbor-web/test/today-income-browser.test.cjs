const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const root = path.resolve(__dirname,'..');
test('income amounts fit narrow cards and open five-column paged receipts', async () => {
  const source = `import {createRoot} from 'react-dom/client';
    import {TodayIncome} from '@/pages/TodayIncome'; import '@/styles/design.css'; import '@/styles/app.css';
    import '@/styles/erp-reference.css'; import '@/pages/erp-today.css';
    createRoot(document.getElementById('root')).render(<TodayIncome date="2026-11-20"/>);`;
  const fixture = `export async function request({query:q}) {
    if(q.category==='temporary')return {available:false,reason:'停车实收待核对'};
    if(q.category==='garage')return {amountCents:123456789,total:21,rows:q.page?[{paidAt:'2026-11-20',period:'202611',plate:'沪A12345',amountCents:6750,remark:q.page===2?'第二页':'合成明细'}]:[]};
    return {amountCents:0,total:0,rows:[]};
  }`;
  const bundle = await esbuild.build({stdin:{contents:source,loader:'tsx',resolveDir:root},bundle:true,write:false,
    jsx:'automatic',format:'iife',outfile:'fixture.js',alias:{'@':path.join(root,'src')},
    define:{'process.env.NODE_ENV':'"test"','import.meta.env.BASE_URL':'"/"'},
    plugins:[{name:'api-fixture',setup(b){b.onResolve({filter:/^@pms\/api-client$/},()=>({path:'api',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixture}));}}]});
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const [viewport,width] of [[1440,570],[923,343],[390,320]]) {
      const page=await browser.newPage({viewport:{width:viewport,height:680}});
      await page.setContent('<meta charset="utf-8"><div id="root" style="width:'+width+'px"></div>');
      await page.addStyleTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.css')).text});
      await page.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
      const button=page.getByRole('button',{name:/车辆管理费/});
      await button.filter({hasText:/1234567\.89/}).waitFor({timeout:5000});
      assert.equal(await page.locator('.erp-fee-item').count(),6);
      assert.ok(await page.locator('.erp-fee-value').evaluateAll(values=>values.every(el=>{
        const r=el.getBoundingClientRect(),card=el.closest('section').getBoundingClientRect();
        return r.right<=card.right && el.scrollWidth<=el.clientWidth+1;
      })));
      await button.click();
      assert.deepEqual(await page.locator('.income-details th').allTextContents(),['收费时间','车牌','费用时段','收费金额','备注']);
      await page.getByText('合成明细',{exact:true}).waitFor();
      await page.getByRole('button',{name:'下一页'}).click();
      await page.getByText('第二页',{exact:true}).waitFor();
      await page.close();
    }
  } finally { await browser.close(); }
});
