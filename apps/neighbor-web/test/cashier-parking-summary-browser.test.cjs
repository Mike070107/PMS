const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..'), out = path.resolve(app, '../../outputs/cashier-summary-style-20261117');
// Compile the exact production cart JSX and styles, not a separately recreated card.
// Synthetic quote/handlers only: no API, payment, database or device execution.
test('parking cart: bold two-line summary and contained payment controls in Chrome', { timeout: 60000 }, async () => {
  fs.mkdirSync(out, { recursive: true });
  const source = fs.readFileSync(path.join(app, 'src/pages/Cashier.tsx'), 'utf8');
  const start = source.indexOf('<div className="card cart2">');
  const end = source.indexOf('\n        </div>', start);
  assert.ok(start > 0 && end > start);
  const cart = source.slice(start, end).trim().replace(/}$/, '');
  const built = await esbuild.build({ stdin: { loader: 'tsx', resolveDir: app, contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import Icon,{IconSprite} from '@/components/Icon';import PayMethods from '@/components/PayMethods';import {money} from '@/lib/format';
import '@/styles/design.css';import '@/styles/app.css';import '@/styles/erp-reference.css';
function Fixture(){const [confirmed,setConfirmed]=useState(false),[pay,setPay]=useState('现金');
const isBillTab=false,tab='pk',billLabel='',parkReady=true,busy=false,canCharge=true,cartTotal=150000;
const PAYMENTS=[{k:'现金'},{k:'微信'},{k:'支付宝'},{k:'转账'}];
const parkCarts=[{plate:'沪M03212',months:12,systemsLabel:'一期地面车库',estimate:{startDate:'2027-01-01',endDate:'2027-12-31',amountCents:150000,
recordedPaymentsToday:[{txnNo:'PK-TEST-1',paidAt:'17:57:53',startDate:'2026-12-01',endDate:'2027-04-30',amountCents:75000},{txnNo:'PK-TEST-2',paidAt:'21:08:07',startDate:'2027-05-01',endDate:'2027-05-31',amountCents:12000}]}}];
const charge=()=>{window.__submitted=(window.__submitted||0)+1};
return <main style={{maxWidth:400,margin:'24px auto',padding:12}}><IconSprite/>${cart}</main>}
createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"test"' } });
  const resources = new Map(built.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
  resources.set('/', Buffer.from('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>'));
  const server = http.createServer((req,res) => {res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(resources.get(req.url)||'');});
  await new Promise(r => server.listen(0,'127.0.0.1',r));let browser;
  const evidence = [], errors = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    for (const width of [1440,375,320]) {
      const page = await browser.newPage({viewport:{width,height:width === 320 ? 560 : 900}});
      page.on('pageerror', e => errors.push(e.message));
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
      await page.goto(origin);await page.getByText('沪M03212 · 12 个月',{exact:true}).waitFor();
      const geometry = await page.evaluate(() => {
        const summary=document.querySelector('.cartItem .cx small'), spans=[...summary.children];
        const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,summary:rect(summary),fontSize:getComputedStyle(summary).fontSize,fontWeight:getComputedStyle(summary).fontWeight,lines:spans.map(e=>({text:e.textContent,...rect(e),lineHeight:getComputedStyle(e).lineHeight})),controls:[...document.querySelectorAll('.cv,.cartTot,.cartFoot button')].map(rect)};
      });
      await page.screenshot({path:path.join(out,`summary-${width}-${process.env.PMS_UI_EVIDENCE_PHASE||'after'}.png`),fullPage:true});
      assert.equal(geometry.lines.length,2,'garage and date range need separate semantic lines');
      assert.equal(geometry.lines[0].text,'一期地面车库');
      assert.equal(geometry.lines[1].text,'2027-01-01 → 2027-12-31');
      assert.ok(geometry.lines[1].y>=geometry.lines[0].bottom);
      assert.ok(geometry.lines[1].height<=parseFloat(geometry.lines[1].lineHeight)+1,'full range fits on next line');
      assert.ok(parseFloat(geometry.fontSize)>=16);assert.ok(Number(geometry.fontWeight)>=600);
      assert.ok(geometry.scroll<=width);for(const r of geometry.controls)assert.ok(r.x>=0&&r.right<=width);
      assert.equal(await page.locator('.cv').textContent(),'¥ 1500.00');
      const paymentNote = page.getByRole('status').filter({hasText:'当天已登记 2 笔停车收款，请核对后确认。'});
      await paymentNote.waitFor();
      assert.match(await paymentNote.innerText(),/17:57:53.*750\.00[\s\S]*2026-12-01 至 2027-04-30.*PK-TEST-1/);
      assert.match(await paymentNote.innerText(),/21:08:07.*120\.00[\s\S]*2027-05-01 至 2027-05-31.*PK-TEST-2/);
      const submit=page.getByRole('button',{name:'确认收款 · ¥ 1500.00',exact:true});
      assert.equal(await submit.isDisabled(),true);await page.locator('.confirmLine').click();assert.equal(await submit.isDisabled(),false);await submit.click();
      assert.equal(await page.evaluate(()=>window.__submitted),1);
      evidence.push(geometry);await page.close();
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({browser:await browser.version(),productionCartJSX:true,syntheticQuote:true,realPayment:false,evidence,errors},null,2));
  } finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
