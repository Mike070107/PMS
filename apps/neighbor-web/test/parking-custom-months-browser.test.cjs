const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..'), api = path.resolve(app, '../api');
const apiRequire = createRequire(path.join(api, 'package.json'));
apiRequire('ts-node').register({ project: path.join(api, 'tsconfig.json'), transpileOnly: true });
const { BusinessService } = apiRequire('./src/modules/business/business.service.ts');
const { priceRule } = apiRequire('./src/modules/business/parking-pricing.ts');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const evidence = path.resolve(app, '../../outputs/parking-custom-months-20261115');
const tiers = [1, 2, 3, 6, 12].map(months => ({ months, amountCents: months === 12 ? 150000 : months * 15000 }));
const base = { id: 18, communityId: 1, billingUnit: 'month', serviceType: 'parking_monthly', name: '亲情车', enabled: true, unitPriceCents: 0 };
const rules = [
  { ...base, config: { priceMode: 'table', vehicleClass: '亲情车', isDefault: true, tiers } },
  { ...base, id: 19, name: '免费月价', config: { priceMode: 'table', isDefault: true, tiers: [{ months: 1, amountCents: 0 }] } },
  { ...base, id: 20, name: '只有年价', unitPriceCents: 12500, config: { priceMode: 'table', isDefault: true, tiers: [{ months: 12, amountCents: 150000 }] } },
  { ...base, id: 21, name: '月价满减', config: { priceMode: 'monthly', isDefault: true, monthlyPriceCents: 15000, discountCycleMonths: 12, discountMonths: 2 } },
];
// Real React components -> loopback test adapter -> real BusinessService.estimateParking.
// Repositories/auth/SQL/payment/device execution are NOT exercised by this browser fixture.
test('自定义11个月：收银台及车辆续期接真实服务算法，桌面/窄屏、套餐、0元、缺价、等待和错误恢复', { timeout: 120000 }, async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const svc = Object.create(BusinessService.prototype); svc.today = () => '2026-11-15';
  const calls = [], errors = [];
  const built = await esbuild.build({ stdin: { resolveDir: app, loader: 'tsx', contents: `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {ConfigProvider} from 'antd'; import {CarRenewal} from '@/components/cashier/ParkingTab';
import RenewSheet from '@/components/vehicle-ops/RenewSheet'; import {priceRule} from '@/lib/parking-pricing';
import '@/styles/app.css';import '@/styles/design.css';import '@/styles/guards.css';import '@/styles/calendar.css';
window.__priceRule=priceRule;
function Fixture(){const [cart,setCart]=useState(null);const rule=window.__rule;const vehicle=new URLSearchParams(location.search).has('vehicle');
const lot={key:'local1',targetKey:'local:phase1_parking',label:'一期地面',endDate:'2027-01-31',system:'local',ref:{kind:'local',database:'parking1',sourceRecordId:'1',previousEndDate:'2027-01-31',label:'一期地面'}};
return <ConfigProvider><main style={{padding:12,maxWidth:1000,margin:'auto'}}><h1>自定义月份隔离验收</h1><p>合成车辆，不真实收费，不下发设备</p>{vehicle?<RenewSheet plate="沪TEST01" rows={[{database:'parking1',fields:{P_id:1,P_plate:'沪TEST01',P_enddate:'2027-01-31',P_effective:'0000101000000000000000',Car_Brand:'亲情车'}}]} cloud={null} onClose={()=>{}} onDone={()=>{}}/>:<><CarRenewal car={{plate:'沪TEST01',identity:'亲情车',lots:[lot]}} rules={[rule]} house={{id:1,communityId:1}} onCart={(_,c)=>setCart(c)}/><output id="cart" style={{display:'block',overflowWrap:'anywhere'}}>{cart?JSON.stringify(cart.estimate):'无可收款报价'}</output></>}</main></ConfigProvider>}
createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, write: false, outfile: 'entry.js', format: 'iife', jsx: 'automatic', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"' }, plugins: [{ name: 'loopback-only', setup(b) {
    b.onResolve({ filter: /^@pms\/api-client$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    b.onResolve({ filter: /^@\/lib\/perm$/ }, () => ({ path: 'perm', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ loader: 'js', contents: a.path === 'perm' ? 'export const can=()=>true;' : `export const accessCardIssuance={};export async function request(o){const r=await fetch('/fixture'+o.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o.data||{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}` }));
  } }] });
  const js = built.outputFiles.find(f => f.path.endsWith('.js')).contents, css = built.outputFiles.find(f => f.path.endsWith('.css'))?.contents || '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/fixture/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body || '{}'); calls.push({ url: url.pathname, data });
      res.setHeader('content-type', 'application/json');
      try {
        if (url.pathname === '/fixture/business/rules') return res.end(JSON.stringify(rules));
        if (url.pathname === '/fixture/business/communities') return res.end(JSON.stringify([{ id: 1, name: '隔离合成小区' }]));
        assert.equal(url.pathname, '/fixture/business/estimate', '禁止其他业务接口');
        const rule = rules.find(r => r.id === data.ruleId); assert.ok(rule);
        // Deliberate quote delay proves old cart is invalidated while waiting.
        await new Promise(resolve => setTimeout(resolve, 150));
        return res.end(JSON.stringify(svc.estimateParking(rule, data, 91)));
      } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: e.message })); }
    }
    if (url.pathname === '/entry.js') { res.setHeader('content-type', 'text/javascript'); return res.end(js); }
    if (url.pathname === '/entry.css') { res.setHeader('content-type', 'text/css'); return res.end(css); }
    const rule = rules.find(r => r.id === Number(url.searchParams.get('rule'))) || rules[0];
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script>window.__rule=${JSON.stringify(rule)}</script><script src="/entry.js"></script></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai' }), page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
    page.on('pageerror', e => errors.push(e.message));
    const cart = () => page.locator('#cart');
    async function waitCart(months, amountCents) { await page.waitForFunction(([m, a]) => { try { const v = JSON.parse(document.querySelector('#cart').textContent); return v.quantity === m && v.amountCents === a; } catch { return false; } }, [months, amountCents]); }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(origin);
      await waitCart(6, 90000);
      const input = page.getByLabel('自定义续期月数'); await input.fill('11');
      assert.equal(await cart().textContent(), '无可收款报价', '等待时旧报价立即失效');
      await waitCart(11, 165000);
      const quote = JSON.parse(await cart().textContent()); assert.equal(quote.startDate, '2027-02-01'); assert.equal(quote.endDate, '2027-12-31');
      assert.match(quote.breakdown, /11个月 × 150元\/月/);
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); assert.ok(geometry.scroll <= width + 1, JSON.stringify(geometry));
      await page.screenshot({ path: path.join(evidence, `cashier-11-${width}.png`), fullPage: true, animations: 'disabled' });
      await page.getByRole('button', { name: '12 个月', exact: true }).click(); await waitCart(12, 150000);
      await input.fill('61'); assert.equal(await cart().textContent(), '无可收款报价');
      await input.fill('11'); await waitCart(11, 165000);
      // Both copies agree for every valid month and configuration, including errors.
      for (const rule of rules) for (let months = 1; months <= 60; months++) {
        let expected; try { expected = priceRule(months, rule.unitPriceCents, rule.config); } catch { expected = null; }
        const actual = await page.evaluate(({ months, rule }) => { try { return window.__priceRule(months, rule.unitPriceCents, rule.config); } catch { return null; } }, { months, rule }); assert.deepEqual(actual, expected);
      }
      await page.goto(`${origin}/?rule=20`); await page.getByLabel('自定义续期月数').fill('11');
      await page.getByText(/没有定 11 个月的价格/).waitFor(); assert.equal(await cart().textContent(), '无可收款报价');
      await page.getByRole('button', { name: '12 个月', exact: true }).click(); await waitCart(12, 150000);
      await page.goto(`${origin}/?rule=19`); await page.getByLabel('自定义续期月数').fill('11'); await waitCart(11, 0);
      await page.goto(`${origin}/?rule=21`); await page.getByLabel('自定义续期月数').fill('11'); await waitCart(11, 165000);
      await page.getByRole('button', { name: '12 个月', exact: true }).click(); await waitCart(12, 150000);
      await page.goto(`${origin}/?vehicle=1`);
      await page.getByLabel('续期车辆类别').selectOption('18');
      await page.getByLabel('自定义续期月数').fill('11'); await page.getByText('标准 ¥1650（亲情车）', { exact: true }).waitFor();
      assert.equal(await page.locator('.sheet .btn.p').isDisabled(), false);
      assert.equal(await page.getByLabel('续期结束日期').inputValue(), '2027-12-31');
      await page.screenshot({ path: path.join(evidence, `vehicle-11-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'browser-verification.json'), JSON.stringify({ fixtureOnly: true, realServicePricing: true, repositoriesAuthSqlPaymentsDevices: false, widths: [1440, 390], calls, errors }, null, 2));
  } catch (e) { if (browser) for (const c of browser.contexts()) for (const p of c.pages()) await p.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); throw e; }
  finally { await browser?.close(); await new Promise(r => server.close(r)); }
});
