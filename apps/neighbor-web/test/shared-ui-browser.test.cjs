const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite/package.json'))('esbuild');
const { listenBrowserLocal } = require('./local-browser-server.cjs');
const app = path.resolve(__dirname, '..'), workspace = path.resolve(app, '../..');
const out = path.join(workspace, 'outputs/simplification-20261117');
fs.mkdirSync(out, { recursive: true });

// Memory-only transport; never contact a real API, even if a local Vite proxy points at production.
const transport = `export const configure=()=>{};export class ApiError extends Error{};
export const METER_READING_STATUS_LABELS={pending:'待复核',confirmed:'已复核',void:'已作废'};
const empty=async()=>({rows:[],total:0,page:1,pageSize:30,summary:{},totals:{receivable:0,paid:0,outstanding:0,adjustment:0}});
export const address={communities:async()=>[{id:1,name:'合成小区'}]};
export const meters={list:empty,readings:empty,charges:empty,ocrSamples:empty,
summary:async()=>({meters:{total:0,active:0,due:0},readings:{meters_read:0},charges:{receivable:0,paid:0,outstanding:0}}),
ocrHealth:async()=>window.__ocrError?{ok:false,provider:'fixture',detail:'合成识别服务离线'}:{ok:true,provider:'fixture'},
create:async(data)=>{window.__writes.push(data);if(window.__holdWrite)await new Promise(r=>window.__releaseWrite=r);if(window.__failWrite)throw Error('合成保存失败');return{id:1,...data};}};
export async function request(o){if(o.url==='/fees/templates/communities')return[];throw Error('Unexpected fixture API: '+o.url);}`;
const entry = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{App,ConfigProvider}from'antd';import zhCN from'antd/locale/zh_CN';
import Meter from'@/legacy/pages/MeterManagementPage';import Template from'@/legacy/pages/FeeTemplateSettings';
import{MaterialPhotosUpload as LocalPhotos}from'@/legacy/components/MaterialPhotos';import{MaterialPhotosUpload as SharedPhotos}from'@legacy/components/MaterialPhotos';
import{FeeTrendChart,FeeBreakdownChart}from'@/legacy/components/FeeReportCharts';import Methods from'@/legacy/components/MeterPaymentMethods';
import'@/legacy/pages/FeesReportShell.css';import'@/legacy/pages/FeeTemplateSettings.css';import'@/components/HouseAddressPicker.css';
window.__writes=[];function Photos(){const[a,A]=useState([]),[b,B]=useState([]);return <><section id="local"><LocalPhotos value={a} onChange={A}/><output>{a.length}</output></section><section id="shared"><SharedPhotos value={b} onChange={B}/><output>{b.length}</output></section><Methods value="cash"/></>}
const rows=[{bucket:'1',amountCents:12300,count:2},{bucket:'2',amountCents:-4500,count:1},{bucket:'3',amountCents:0,count:0}];
const mode=new URLSearchParams(location.search).get('mode');createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN} theme={{token:{motion:false}}}><App>{mode==='photos'?<Photos/>:mode==='charts'?<><FeeTrendChart rows={rows} loading={false} label={x=>x}/><FeeBreakdownChart rows={rows.map(r=>({...r,key:r.bucket,name:r.bucket,share:null}))} loading={false}/></>:mode==='template'?<Template/>:<Meter/>}</App></ConfigProvider>);`;

async function bundle(phase) {
  const snapshots = phase === 'before' ? JSON.parse(fs.readFileSync(path.join(out, 'verified-before-sources.json'), 'utf8')) : {};
  return esbuild.build({ stdin: { contents: entry, resolveDir: app, loader: 'tsx' }, bundle: true, write: false, format: 'iife', outfile: 'fixture.js', jsx: 'automatic',
    alias: { '@': path.join(app, 'src'), '@legacy': path.join(workspace, 'apps/admin-web/src'), '@pms/shared-types': path.join(workspace, 'packages/shared-types/src/index.ts') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_API_BASE_URL': '"/api/v1"' },
    plugins: [{ name: 'isolated-reuse-verification', setup(b) {
      b.onResolve({ filter: /^@pms\/api-client$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: transport, loader: 'js', resolveDir: app }));
      b.onLoad({ filter: /\.(?:tsx?|css)$/ }, ({ path: file }) => { const original = snapshots[path.relative(workspace, file).replace(/\\/g, '/')]; return original === undefined ? undefined : { contents: original, loader: path.extname(file).slice(1), resolveDir: path.dirname(file) }; });
    } }],
  });
}

test('共用界面桌面/窄屏视觉不变；等待、错误、草稿、成功及跨实现粘贴均保留', { timeout: 120000 }, async () => {
  const results = [], errors = [], snapshots = new Map();
  const phases = fs.existsSync(path.join(out, 'verified-before-sources.json')) ? ['before', 'after'] : ['after'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    for (const phase of phases) {
      const built = await bundle(phase), files = new Map(built.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
      const server = http.createServer((q, s) => { s.setHeader('content-type', q.url.endsWith('.js') ? 'text/javascript' : q.url.endsWith('.css') ? 'text/css' : 'text/html;charset=utf-8'); s.end(files.get(q.url) || '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:16px;background:white}section{padding:12px;margin-bottom:20px;border:1px solid #ddd}</style><div id="root"></div><script src="/fixture.js"></script>'); });
      await listenBrowserLocal(server);
      const origin = 'http://127.0.0.1:' + server.address().port;
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', timezoneId: 'Asia/Shanghai' });
      context.setDefaultTimeout(6000);
      await context.addInitScript(() => {
        const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
        sessionStorage.setItem('pms.admin.token', 'fixture.' + payload + '.signature');
        sessionStorage.setItem('pms.admin.user', JSON.stringify({ id: 7, tenantId: 8 }));
        const readOnly = new URLSearchParams(location.search).get('readonly') === '1';
        sessionStorage.setItem('pms.admin.access', JSON.stringify({ pages: { meters: { view: true, edit: !readOnly, delete: !readOnly }, settings: { view: true, edit: !readOnly } } }));
        window.__ocrError = new URLSearchParams(location.search).get('error') === '1';
      });
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      try {
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        for (const mode of ['meters', 'template', 'charts', 'photos']) {
          await page.goto(origin + '?mode=' + mode);
          await page.locator(mode === 'meters' ? '.meter-body' : mode === 'charts' ? '.fees-trend-chart' : mode === 'photos' ? '#local' : '.fee-template-settings').waitFor();
          await page.waitForFunction(() => !document.querySelector('.ant-spin-spinning'));
          for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(() => document.fonts.ready);
            const key = `${mode}-${width}`, image = await page.screenshot({ path: path.join(out, `${phase}-${key}.png`), fullPage: true, animations: 'disabled' });
            if (phase === 'before') snapshots.set(key, image);
            else if (snapshots.has(key)) assert.ok(image.equals(snapshots.get(key)), 'Visual regression: ' + key);
            results.push(`${phase}:${key}`);
          }
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(origin + '?mode=meters&readonly=1');
        await page.locator('.meter-body').waitFor();
        assert.equal(await page.getByRole('button', { name: /新增仪表/ }).count(), 0);
        await page.goto(origin + '?mode=meters&error=1');
        await page.getByText('读数字识别服务未连接', { exact: true }).waitFor();
        await page.getByRole('button', { name: /新增仪表/ }).click();
        await page.getByPlaceholder('表壳上的编号').fill('SYNTHETIC-REUSE-001');
        await page.evaluate(() => { window.__holdWrite = true; window.__failWrite = true; });
        const save = page.locator('.ant-modal:visible .ant-modal-footer .ant-btn-primary'); await save.click();
        await page.waitForFunction(() => typeof window.__releaseWrite === 'function');
        assert.match(await save.getAttribute('class'), /loading/);
        assert.equal(await page.evaluate(() => window.__writes.length), 1);
        await page.evaluate(() => window.__releaseWrite());
        await page.getByText('合成保存失败', { exact: true }).waitFor();
        assert.equal(await page.getByPlaceholder('表壳上的编号').inputValue(), 'SYNTHETIC-REUSE-001');
        await page.evaluate(() => { window.__holdWrite = false; window.__failWrite = false; });
        await save.click(); await page.getByText('仪表已建档', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__writes.length), 2);
        results.push(`${phase}:readonly/loading/error/draft/success`);
        if (phase === 'after') {
          let uploads = 0;
          await context.route('**/api/v1/upload', async route => { uploads++; await route.fulfill({ json: { displayUrl: '/fixture-image-' + uploads + '.png' } }); });
          await page.goto(origin + '?mode=photos');
          const upload = section => page.locator(section + ' input[type=file]');
          const image = { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') };
          await upload('#local').setInputFiles(image); await page.waitForFunction(() => document.querySelector('#local output')?.textContent === '1');
          await page.locator('#local').hover(); await page.locator('#shared').hover();
          assert.equal(await page.locator('[data-paste-upload-target="active"]').count(), 1);
          await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1, 2, 3])], 'paste.png', { type: 'image/png' })); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })); });
          await page.waitForFunction(() => document.querySelector('#shared output')?.textContent === '1');
          assert.equal(await page.locator('#local output').textContent(), '1'); assert.equal(uploads, 2);
          await page.locator('#local .ant-upload-drag .ant-upload-btn').evaluate(element => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([1])], 'drop.png', { type: 'image/png' })); element.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true })); });
          await page.waitForFunction(() => document.querySelector('#local output')?.textContent === '2');
          assert.equal(uploads, 3);
          results.push('after:click/drag/paste/single-active-target');
        }
        assert.deepEqual(errors, []);
      } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
    }
  } finally { await browser?.close(); fs.writeFileSync(path.join(out, 'browser-result.json'), JSON.stringify({ results, errors, visualComparison: snapshots.size, externalNetwork: 'blocked', productionWrites: 0 }, null, 2)); }
});
