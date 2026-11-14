const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createRequire } = require('node:module'), { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..'), root = path.resolve(app, '../..');
const evidence = path.join(root, 'outputs/vehicle-preservation-browser');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
test('real new and legacy entries: preservation, isolated type, unknown recovery, partial failure and responsive states', { timeout: 240000 }, async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const built = await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BrowserRouter} from 'react-router-dom'; import {App,ConfigProvider} from 'antd'; import Vehicles from '@/pages/Vehicles'; import Legacy from '${path.join(root, 'apps/admin-web/src/pages/ParkingManagementPage.tsx').replaceAll('\\','/')}'; import {fixtureRows,fixtureReadiness} from '@pms/api-client'; import '@/styles/design.css'; import '@/styles/app.css'; const legacy=new URLSearchParams(location.search).get('entry')==='legacy'; createRoot(document.getElementById('root')).render(<ConfigProvider><App><BrowserRouter>{legacy?<Legacy readinessOverride={fixtureReadiness} rowsOverride={fixtureRows} deliyunRowsOverride={[]} communitiesOverride={[]}/>:<Vehicles/>}</BrowserRouter></App></ConfigProvider>);`, loader: 'tsx', resolveDir: app }, bundle: true, write: false, outfile: 'entry.js', format: 'iife', jsx: 'automatic', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_LEGACY_BASE': '""', 'import.meta.env.VITE_API_BASE_URL': '""' }, plugins: [{ name: 'controlled-transport', setup(b) {
    b.onResolve({ filter: /^@pms\/api-client$/ }, () => ({ path: path.join(__dirname, 'preservation-browser-api.ts') }));
    b.onResolve({ filter: /(?:^@\/lib\/(?:auth|perm)$|\/lib\/auth$)/ }, a => ({ path: a.path, namespace: 'auth-fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'auth-fixture' }, () => ({ loader: 'js', contents: `const writable=new URLSearchParams(location.search).get('scenario')!=='readonly'; const session={user:{id:1,tenantId:12,name:'验收收费员'},access:{isTenantAdmin:true,scopeAll:true},actingTenant:null}; export const can=()=>writable; export const useSession=()=>session; export const useAuth=()=>session; export const usePagePerm=()=>({canView:true,canEdit:writable,canDelete:false}); export const auth={getUser:()=>session.user,getAccess:()=>session.access};` }));
  } }] });
  const js = built.outputFiles.find(f => f.path.endsWith('.js')).contents, css = built.outputFiles.find(f => f.path.endsWith('.css'))?.contents || '';
  const server = http.createServer((req, res) => { if (req.url === '/entry.js') { res.setHeader('content-type', 'text/javascript'); res.end(js); } else if (req.url === '/entry.css') { res.setHeader('content-type', 'text/css'); res.end(css); } else { res.setHeader('content-type', 'text/html'); res.end('<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body style="margin:0;padding:12px"><div id="root"></div><script src="/entry.js"></script></body></html>'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser; const errors = [], results = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
    const state = () => page.evaluate(() => structuredClone(window.__preserveFixture));
    const posts = async () => (await state()).calls.filter(c => c.name === 'createParkingOperation');
    const shot = name => page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true, animations: 'disabled' });
    async function open(entry = 'modern', kind = 'plate', scenario = 'success', width = 1440) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(`${origin}/?entry=${entry}&scenario=${scenario}`); await page.evaluate(() => localStorage.clear());
      if (entry === 'modern') {
        await page.locator('.hsearch input').first().fill('沪ATEST01'); await page.getByRole('button', { name: '查询', exact: true }).click();
        await page.locator('.veh-card').first().getByRole('button', { name: kind === 'plate' ? '变更车牌' : '修改车辆类型', exact: true }).click();
      } else {
        await page.getByPlaceholder('输入房号、住户、电话或车牌').fill('沪ATEST01'); await page.getByPlaceholder('输入房号、住户、电话或车牌').press('Enter');
        if (kind === 'plate') await page.getByRole('button', { name: /变更车牌/ }).first().click();
        else await page.locator('.parking-vehicle-type button').first().click();
      }
      const dialog = page.getByRole('dialog').last(); await dialog.waitFor(); return dialog;
    }
    async function fill(dialog, entry, kind) {
      if (kind === 'plate') await dialog.getByLabel('新车牌', { exact: true }).fill('沪BTEST02');
      else if (entry === 'modern') { await dialog.getByLabel('修改停车库（仅所选库）').selectOption('parking2'); await dialog.getByLabel('新的车辆类型').selectOption('亲情车'); }
      else { await dialog.locator('.ant-select-selector').click(); await page.getByTitle('亲情车', { exact: true }).click(); }
    }
    const submit = (dialog, entry, kind) => dialog.getByRole('button', { name: entry === 'legacy' ? '提交操作' : kind === 'plate' ? '确认换牌' : '确认修改车辆类型', exact: true }).click();
    for (const entry of ['modern', 'legacy']) for (const kind of ['plate', 'type']) {
      const dialog = await open(entry, kind, 'success', 1440); await fill(dialog, entry, kind); await shot(`${entry}-${kind}-desktop`); await submit(dialog, entry, kind); await dialog.waitFor({ state: 'hidden' });
      const data = await state(), writes = await posts(); assert.equal(writes.length, kind === 'plate' ? 2 : 1);
      assert.equal(data.rows[0].fields.Car_Lei, null); assert.equal(data.rows[1].fields.Car_Lei, '历史授权'); assert.equal(data.billed, '住户车-1');
      if (kind === 'plate') { assert.equal(data.rows[0].fields.Car_Brand, null); assert.equal(data.rows[1].fields.Car_Brand, '租户车'); assert.ok(writes.every(c => Object.keys(c.data.payload).sort().join(',') === 'batchId,newPlate,plate,sourceQueryId')); }
      else { const selected = writes[0].data.database; for (const row of data.rows) assert.equal(row.fields.Car_Brand, row.database === selected ? '亲情车' : row.database === 'parking1' ? null : '租户车'); }
      assert.ok(data.calls.filter(c => c.name === 'createParkingQuery').length >= (entry === 'modern' ? 3 : kind === 'plate' ? 2 : 1)); await shot(`${entry}-${kind}-success`); results.push({ entry, kind, writes: writes.length, independentReadback: true });
    }
    for (const entry of ['modern', 'legacy']) for (const width of [390, 320]) for (const kind of ['plate', 'type']) {
      const dialog = await open(entry, kind, 'success', width); await fill(dialog, entry, kind); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await shot(`${entry}-${kind}-${width}`); await submit(dialog, entry, kind); await dialog.waitFor({ state: 'hidden' }); results.push({ entry, width, kind, horizontalOverflow: false });
    }
    for (const entry of ['modern', 'legacy']) for (const scenario of ['failed', 'badReceipt']) {
      const dialog = await open(entry, 'type', scenario, 390); await fill(dialog, entry, 'type'); await submit(dialog, entry, 'type');
      await (entry === 'legacy' ? dialog.locator('.ant-alert-error').first() : dialog.getByRole('alert')).waitFor(); await shot(`${entry}-type-${scenario}-390`);
      const original = await posts(); assert.equal(original.length, 1);
      if (entry === 'modern') await dialog.getByRole('button', { name: '核对原任务（同一请求）', exact: true }).click(); else await submit(dialog, entry, 'type');
      await (entry === 'legacy' ? dialog.locator('.ant-alert-error').first() : dialog.getByRole('alert')).waitFor(); assert.equal((await posts()).length, original.length);
      results.push({ entry, kind: 'type', scenario, noNewTask: true });
    }
    for (const scenario of ['failed', 'partial', 'badReceipt']) {
      const dialog = await open('modern', 'plate', scenario, 390); await fill(dialog, 'modern', 'plate'); await submit(dialog, 'modern', 'plate'); await dialog.getByRole('alert').waitFor(); await shot(`${scenario}-390`);
      const original = await posts(); await dialog.getByRole('button', { name: '核对原请求（不重复办理）', exact: true }).click(); await dialog.getByRole('alert').waitFor(); assert.equal((await posts()).length, original.length); assert.equal(await dialog.getByLabel('新车牌', { exact: true }).inputValue(), '沪BTEST02'); results.push({ scenario, inputRetained: true, noNewTask: true });
    }
    for (const entry of ['modern', 'legacy']) for (const scenario of ['lostResponse', 'pollFailure']) {
      const dialog = await open(entry, 'plate', scenario); await fill(dialog, entry, 'plate'); await submit(dialog, entry, 'plate'); await (entry === 'legacy' ? dialog.locator('.ant-alert-error').first() : dialog.getByRole('alert')).waitFor();
      const original = (await posts())[0].data; await page.evaluate(() => { window.__preserveFixture.released = true; });
      if (entry === 'modern') await dialog.getByRole('button', { name: '核对原请求（不重复办理）', exact: true }).click(); else await submit(dialog, entry, 'plate');
      await dialog.waitFor({ state: 'hidden' }); const writes = await posts(), first = writes.filter(c => c.data.database === 'parking1'); assert.ok(first.every(c => c.data.idempotencyKey === original.idempotencyKey)); assert.equal(first.length, scenario === 'lostResponse' ? 2 : 1); results.push({ entry, scenario, sameOriginalKey: true });
    }
    {
      const dialog = await open('modern', 'plate', 'waiting', 390); await fill(dialog, 'modern', 'plate'); await submit(dialog, 'modern', 'plate'); await dialog.getByRole('status').waitFor(); await shot('waiting-390'); assert.equal((await posts()).length, 1); await page.evaluate(() => { window.__preserveFixture.released = true; }); await dialog.waitFor({ state: 'hidden' }); results.push({ scenario: 'waiting', noEarlySuccess: true });
    }
    {
      const dialog = await open('modern', 'plate', 'cloudUnknown'); assert.equal(await dialog.getByRole('button', { name: '确认换牌', exact: true }).isDisabled(), true); assert.equal((await posts()).length, 0); results.push({ scenario: 'cloudUnknown', blocked: true });
    }
    for (const entry of ['modern', 'legacy']) {
      await page.setViewportSize({ width: 390, height: 1000 }); await page.goto(`${origin}/?entry=${entry}&scenario=readonly`); await page.evaluate(() => localStorage.clear());
      if (entry === 'modern') {
        await page.locator('.hsearch input').first().fill('沪ATEST01'); await page.getByRole('button', { name: '查询', exact: true }).click();
        for (const name of ['变更车牌', '修改车辆类型']) assert.equal(await page.locator('.veh-card').first().getByRole('button', { name, exact: true }).isDisabled(), true);
      } else {
        await page.getByPlaceholder('输入房号、住户、电话或车牌').fill('沪ATEST01'); await page.getByPlaceholder('输入房号、住户、电话或车牌').press('Enter');
        assert.equal(await page.getByRole('button', { name: /变更车牌/ }).first().isDisabled(), true); assert.equal(await page.locator('.parking-vehicle-type button').first().isDisabled(), true);
      }
      assert.equal((await posts()).length, 0); await shot(`${entry}-readonly-390`); results.push({ entry, scenario: 'readonly', blocked: true });
    }
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify({ fixtureOnly: true, productionSqlDevicesTested: false, realComponents: ['Vehicles', 'PlateChangeSheet', 'VehicleTypeSheet', 'ParkingManagementPage'], results, errors }, null, 2));
  } catch (e) { fs.writeFileSync(path.join(evidence, 'failure.json'), JSON.stringify({ message: e.message, stack: e.stack, results, errors }, null, 2)); if (browser) for (const context of browser.contexts()) for (const page of context.pages()) await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); throw e; }
  finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
