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
  const fixture = `export async function request({url,query:q,data}) {
    if(url.includes('/parking/fees/details/queries')){
      if(data.category!=='exit_due'||!['parking1','parking2'].includes(data.database))throw Error('分期错误');
      const first=data.database==='parking1', amountCents=first?1000:500;
      if(first && window.phaseError) throw Error('一期车类未识别');
      if(data.page===2 && !first)throw Error('分页串库');
      return {id:1,status:'completed',rows:[{database:data.database,fields:{kind:'summary',count:1,amountCents}},
        {database:data.database,fields:{kind:'detail',vehicleClass:first?'临时车':'亲情车',occurredAt:'2026-11-20 19:23:50',enteredAt:'2026-11-20 18:42:52',plate:'测试车',amountCents}}]};
    }
    if(q.category==='temporary')return {available:false,reason:'停车实收待核对'};
    if(q.category==='garage' && q.source==='mis' && window.phaseError)throw Error('MIS读取失败');
    if(q.category==='garage' && q.source==='pms')return {amountCents:10000,total:1,rows:q.page?[{paidAt:'2026-11-20',plate:'沪B12345',amountCents:10000,remark:'PMS合成明细'}]:[]};
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
      assert.match(await button.innerText(),/PMS 实收.*100.00/s);
      assert.match(await button.innerText(),/差额.*-1234467.89/s);
      assert.match(await page.locator('.erp-fee-donut-center').innerText(),/1234567.89/);
      await button.click();
      assert.deepEqual(await page.locator('.income-details th').allTextContents(),['收费时间','车牌','费用时段','收费金额','备注']);
      await page.getByText('合成明细',{exact:true}).waitFor();
      await page.getByRole('button',{name:'下一页'}).click();
      await page.getByText('第二页',{exact:true}).waitFor();
      await page.getByRole('button',{name:'PMS 实收',exact:true}).click();
      await page.getByText('PMS合成明细',{exact:true}).waitFor();
      assert.equal(await page.getByText('第二页',{exact:true}).count(),0);
      await page.keyboard.press('Escape');
      const due=page.getByRole('button',{name:/临时停车费/});
      await due.filter({hasText:'15.00'}).click();
      await page.getByText('当期应收 ¥ 10.00 · 1 笔',{exact:true}).waitFor();
      await page.getByRole('columnheader',{name:'车类'}).waitFor();
      assert.deepEqual(await page.locator('.income-details th').allTextContents(),['出场时间','车牌','车类','停车时段','应收金额','备注']);
      await page.getByRole('cell',{name:'临时车',exact:true}).waitFor();
      assert.equal(await page.getByRole('cell',{name:'亲情车',exact:true}).count(),0);
      assert.equal(await page.getByRole('tab',{selected:true}).innerText(),'一期');
      await page.getByRole('tab',{name:'二期'}).click();
      await page.getByRole('cell',{name:'亲情车',exact:true}).waitFor();
      await page.close();
      if(viewport===390){
        const failed=await browser.newPage({viewport:{width:390,height:680}});
        await failed.setContent('<div id="root"></div>');await failed.evaluate(()=>window.phaseError=true);
        await failed.addScriptTag({content:bundle.outputFiles.find(f=>f.path.endsWith('.js')).text});
        await failed.getByRole('button',{name:/车辆管理费.*MIS 人工录入.*未获取.*PMS 实收.*100.00.*差额.*—/}).waitFor();
        await failed.getByRole('button',{name:/临时停车费.*未获取/}).click();
        await failed.getByText('一期车类未识别',{exact:false}).first().waitFor();
        await failed.getByRole('tab',{name:'二期'}).click();
        await failed.getByRole('cell',{name:'亲情车',exact:true}).waitFor();
        await failed.close();
      }
    }
  } finally { await browser.close(); }
});
