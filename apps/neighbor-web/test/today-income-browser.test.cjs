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
    if(q?.date==='2026-11-19' && ['berth','garage'].includes(q.category)){
      const paid=q.source==='pms'?3000:2000;
      return {amountCents:paid,total:1,rows:q.page?[{paidAt:q.date,amountCents:paid,remark:q.source+' 昨日明细'}]:[]};
    }
    if(url.includes('/parking/fees/details/queries')){
      if(data.category!=='exit_due'||!['parking1','parking2'].includes(data.database))throw Error('分期错误');
      const first=data.database==='parking1', amountCents=first?1000:500;
      if(first && window.phaseError) throw Error('一期车类未识别');
      if(data.page===2 && !first)throw Error('分页串库');
      return {id:1,status:'completed',rows:[{database:data.database,fields:{kind:'summary',count:1,amountCents}},
        {database:data.database,fields:{kind:'detail',vehicleClass:first?'临时车':'亲情车',occurredAt:'2026-11-20 19:23:50',enteredAt:'2026-11-20 18:42:52',plate:'测试车',amountCents}}]};
    }
    if(q.category==='temporary')return {available:false,reason:'停车实收待核对'};
    if(q.category==='berth' && q.source==='pms')return {
      amountCents:152000,total:22,rows:q.page?[{
        paidAt:q.page===2?'2026-11-20 17:57:53':'2026-11-20 21:08:07',
        plate:'苏U935Z7',amountCents:75000,samePlateCount:2,
      },{paidAt:q.date,plate:'沪B12345',amountCents:100,samePlateCount:1}]:[],
    };
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
      assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).width), Math.min(800, viewport));
      assert.deepEqual(await page.locator('.income-details th').allTextContents(),['收费时间','车牌','费用时段','收费金额','备注']);
      await page.getByText('合成明细',{exact:true}).waitFor();
      assert.match(await page.getByRole('heading',{name:'清单汇总'}).innerText(), /21 笔.*1234567\.89/);
      await page.getByRole('button',{name:'下一页'}).click();
      await page.getByText('第二页',{exact:true}).waitFor();
      assert.match(await page.getByRole('heading',{name:'清单汇总'}).innerText(), /21 笔.*1234567\.89/);
      await page.getByRole('button',{name:'PMS 实收',exact:true}).click();
      await page.getByText('PMS合成明细',{exact:true}).waitFor();
      assert.match(await page.getByRole('heading',{name:'清单汇总'}).innerText(), /1 笔.*100\.00/);
      assert.equal(await page.getByText('第二页',{exact:true}).count(),0);
      await page.keyboard.press('Escape');
      await page.getByRole('button',{name:/泊位费/}).click();
      await page.getByRole('button',{name:'PMS 实收',exact:true}).click();
      await page.getByText('同日 2 笔，核对是否重复',{exact:true}).waitFor();
      assert.equal(await page.locator('.income-repeat').count(),1);
      assert.match(await page.getByRole('heading',{name:'清单汇总'}).innerText(), /22 笔.*1520\.00/);
      await page.getByRole('button',{name:'下一页'}).click();
      await page.getByText('2026-11-20 17:57:53',{exact:true}).waitFor();
      assert.equal(await page.getByText('同日 2 笔，核对是否重复',{exact:true}).count(),1);
      await page.keyboard.press('Escape');
      const due=page.getByRole('button',{name:/临时停车费/});
      await due.filter({hasText:'15.00'}).click();
      assert.equal(Math.round((await page.getByRole('dialog').boundingBox()).width), Math.min(1100, viewport));
      await page.getByText('当期应收 ¥ 10.00 · 1 笔',{exact:true}).waitFor();
      await page.getByRole('columnheader',{name:'车类'}).waitFor();
      const tableWrap = page.locator('.intro-table-wrap');
      if (viewport === 390) {
        await page.waitForFunction(() => {
          const el = document.querySelector('.income-exit-wrap');
          if (!el) return false;
          el.scrollLeft = el.scrollWidth;
          return el.scrollLeft > 0 && el.getBoundingClientRect().right <= innerWidth + 1;
        });
      } else if (viewport === 1440) {
        assert.equal(await tableWrap.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      }
      assert.deepEqual(await page.locator('.income-details th').allTextContents(),['出场时间','车牌','车类','停车时段','应收金额','备注']);
      await page.getByRole('cell',{name:'临时车',exact:true}).waitFor();
      assert.equal(await page.getByRole('cell',{name:'亲情车',exact:true}).count(),0);
      assert.equal(await page.getByRole('tab',{selected:true}).innerText(),'一期');
      await page.getByRole('tab',{name:'二期'}).click();
      await page.getByRole('cell',{name:'亲情车',exact:true}).waitFor();
      await page.keyboard.press('Escape');
      const calendar=page.getByRole('textbox',{name:'对账日期'});
      assert.equal(await calendar.inputValue(),'2026-11-20');
      await calendar.click();
      await page.locator('td[title="2026-11-19"]').click();
      for(const name of ['泊位费','车辆管理费']){
        const row=page.getByRole('button',{name:new RegExp(name)});
        await row.filter({hasText:/MIS 人工录入.*20.00.*PMS 实收.*30.00.*差额.*10.00/}).waitFor();
        await row.click();
        await page.getByText('mis 昨日明细',{exact:true}).waitFor();
        assert.match(await page.getByRole('heading',{name:'清单汇总'}).innerText(), /1 笔.*20\.00/);
        await page.getByRole('button',{name:'PMS 实收',exact:true}).click();
        await page.getByText('pms 昨日明细',{exact:true}).waitFor();
        assert.match(await page.getByRole('heading',{name:'清单汇总'}).innerText(), /1 笔.*30\.00/);
        await page.keyboard.press('Escape');
      }
      await calendar.click();
      await page.locator('td[title="2026-11-20"]').click();
      await button.filter({hasText:/1234567\.89/}).waitFor();
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
