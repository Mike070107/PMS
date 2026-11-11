const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');

// Render the production adapter with the same polling rerender that Cashier's
// pending registration list causes. There is no transport/business backend.
test('date panels survive polling: next month/year, min/max, clear and external value', { timeout: 60000 }, async () => {
  const built = await esbuild.build({
    stdin: { contents: `import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';
      import DateInput from '@/components/DateInput';import{CarRenewal}from'@/components/cashier/ParkingTab';
      const car={plate:'沪TEST99',identity:'合成测试车',lots:[{key:'sample',targetKey:'local:phase1_parking',label:'合成车库',endDate:'2098-11-30',ref:{system:'local',database:'parking1',sourceRecordId:'1',currentEndDate:'2098-11-30'}}],mismatch:null};
      const rules=[{id:1,communityId:1,serviceType:'parking_monthly',name:'合成标准',enabled:true,unitPriceCents:10000,config:{priceMode:'monthly',monthlyPriceCents:10000,isDefault:true}}];
      import '@/styles/design.css';import '@/styles/app.css';
      function Fixture(){const[tick,setTick]=useState(0),[value,setValue]=useState('2026-11-11');
        useEffect(()=>{const id=setInterval(()=>setTick(t=>t+1),100);return()=>clearInterval(id)},[]);
        return <main style={{padding:20,maxWidth:600}}><h1>停车缴费 · 自定日期</h1><output id="poll">{tick}</output>
          <label>开始日期<DateInput id="from" value={value} name="startDate" onChange={e=>setValue(e.target.value)} /></label>
          <label>结束日期<DateInput id="until" value="2026-11-30" min="2026-11-11" max="2028-12-31" /></label>
          <label>月份<DateInput id="month" type="month" value="2026-11" /></label>
          <label>时间<DateInput id="time" type="datetime-local" value="2026-11-11T13:20" /></label>
          <button id="external" onClick={()=>setValue('2027-06-05')}>切换日期</button><output id="value">{value}</output><section id="real"><h2>真实停车新办缴费组件 · 仅合成数据</h2><CarRenewal car={car} rules={rules} house={{id:1,communityId:1}} intakeId={900} title="新办" onCart={(plate,c)=>{window.__cart=c}} /></section></main>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`, loader: 'tsx', resolveDir: app },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js',
    alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname,'parking-browser-api.ts'), '@/lib/perm': path.join(__dirname,'parking-browser-permission.ts'), '@pms/shared-types': path.join(app,'../../packages/shared-types/src/index.ts') }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL':'"/"' },
  });
  const server = http.createServer((req,res)=>{
    const ext=req.url==='/fixture.js'?'js':req.url==='/fixture.css'?'css':'html';
    res.setHeader('Content-Type',{js:'text/javascript',css:'text/css',html:'text/html;charset=utf-8'}[ext]);
    res.end(ext==='html'?'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>':built.outputFiles.find(f=>f.path.endsWith('.'+ext)).contents);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror', e=>errors.push(e.message));
    const origin=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
    await page.goto(origin);
    const popup=()=>page.locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)').last();
    const close=async()=>{await page.locator('h1').click();await page.waitForFunction(()=>![...document.querySelectorAll('.ant-picker-dropdown')].some(e=>e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden'&&!e.classList.contains('ant-picker-dropdown-hidden')));};
    const afterPoll=async()=>{const n=Number(await page.locator('#poll').textContent());await page.waitForFunction(n=>Number(document.getElementById('poll').textContent)>n+3,n);};
    await page.locator('#from').click();
    await popup().locator('.ant-picker-header-next-btn').click();
    await afterPoll();
    assert.match(await popup().locator('.ant-picker-month-btn').textContent(),/^(12月|Dec)$/,'polling must not reset the browsed month');
    await popup().locator('.ant-picker-header-super-next-btn').click();
    await afterPoll();
    assert.match(await popup().locator('.ant-picker-year-btn').textContent(),/^2027年?$/,'polling must not reset the browsed year');
    await popup().locator('td[title="2027-12-15"]').click();
    assert.equal(await page.locator('#value').textContent(),'2027-12-15');
    await page.locator('#from').click();await popup().locator('.ant-picker-header-next-btn').click();await afterPoll();
    assert.match(await popup().locator('.ant-picker-year-btn').textContent(),/^2028年?$/);
    const evidence=path.join(app,'../../outputs/date-input-stability-20261111');fs.mkdirSync(evidence,{recursive:true});
    await page.screenshot({path:path.join(evidence,'calendar-desktop.png'),animations:'disabled'});
    await close();await page.locator('#external').click();
    await page.waitForFunction(()=>document.getElementById('from').value==='2027-06-05');
    assert.equal(await page.locator('#from').inputValue(),'2027-06-05');
    await page.locator('#from').click();await afterPoll();assert.match(await popup().locator('.ant-picker-month-btn').textContent(),/^(6月|Jun)$/);
    await close();
    await page.locator('#until').click();
    assert.ok((await popup().locator('td[title="2026-11-10"]').getAttribute('class')).includes('disabled'));
    await popup().locator('.ant-picker-header-super-next-btn').click();await afterPoll();
    assert.match(await popup().locator('.ant-picker-year-btn').textContent(),/^2027年?$/);
    await close();
    await page.locator('#month').click();await popup().locator('.ant-picker-header-super-next-btn').click();await afterPoll();
    assert.match(await popup().locator('.ant-picker-year-btn').textContent(),/^2027年?$/);await close();
    await page.locator('#time').click();await popup().locator('.ant-picker-header-next-btn').click();await afterPoll();
    assert.match(await popup().locator('.ant-picker-month-btn').textContent(),/^(12月|Dec)$/);await close();
    await page.setViewportSize({width:390,height:844});await page.locator('#from').click();await popup().locator('.ant-picker-header-next-btn').click();await afterPoll();
    assert.match(await popup().locator('.ant-picker-month-btn').textContent(),/^(7月|Jul)$/);
    await page.screenshot({path:path.join(evidence,'calendar-mobile.png'),animations:'disabled'});
    const bounds=await popup().boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391,JSON.stringify(bounds));
    await close();await page.locator('#from').hover();
    await page.locator('.ant-picker').filter({has:page.locator('#from')}).locator('.ant-picker-clear').click();
    await page.waitForFunction(()=>document.getElementById('value').textContent==='');
    assert.equal(await page.locator('#value').textContent(),'');
    await page.setViewportSize({width:1440,height:900});
    await page.locator('#real').getByRole('button',{name:'自定日期',exact:true}).click();
    const actualStart=page.locator('#real .ant-picker input').first();
    await actualStart.click();await popup().locator('.ant-picker-header-next-btn').click();await popup().locator('.ant-picker-header-super-next-btn').click();await afterPoll();
    assert.match(await popup().locator('.ant-picker-month-btn').textContent(),/^(1月|Jan)$/);
    assert.match(await popup().locator('.ant-picker-year-btn').textContent(),/^2100年?$/);
    await popup().locator('td[title="2100-01-15"]').click();await page.waitForFunction(()=>document.querySelector('#real .ant-picker input').value==='2100-01-15');
    await close();await afterPoll();assert.equal(await actualStart.inputValue(),'2100-01-15');
    await page.screenshot({path:path.join(evidence,'cashier-custom-date-desktop.png'),animations:'disabled'});
    await page.setViewportSize({width:390,height:844});await actualStart.click();await popup().locator('.ant-picker-header-next-btn').click();await afterPoll();assert.match(await popup().locator('.ant-picker-month-btn').textContent(),/^(2月|Feb)$/);
    await page.screenshot({path:path.join(evidence,'cashier-custom-date-mobile.png'),animations:'disabled'});
    const actualBounds=await popup().boundingBox();assert.ok(actualBounds.x>=0&&actualBounds.x+actualBounds.width<=391,JSON.stringify(actualBounds));
    assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
