const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const evidence = path.resolve(app, '../../outputs/vehicle-intake-focus-20261111');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
let built;
async function fixture(width) {
  built ||= await esbuild.build({ entryPoints: [path.join(__dirname, 'vehicle-intake-navigation-fixture.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname, 'vehicle-intake-navigation-transport.ts'), '@pms/shared-types': path.resolve(app, '../../packages/shared-types/src/index.ts') }, define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_LEGACY_BASE': '""', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'isolated-auth', setup(build) {
    build.onResolve({ filter: /^@\/lib\/(auth|perm)$/ }, a => ({ path: a.path, namespace: 'auth-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'auth-fixture' }, a => ({ contents: a.path.endsWith('/perm') ? 'export const can=()=>true;' : `import {session} from '${path.join(__dirname, 'vehicle-intake-navigation-transport.ts').replace(/\\/g, '/')}';export const useSession=()=>session;`, loader: 'js', resolveDir: app }));
  } }] });
  fs.mkdirSync(evidence, { recursive: true });
  const server = http.createServer((req, res) => {
    const ext = req.url === '/fixture.js' ? 'js' : req.url === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8' }[ext]);
    res.end(ext === 'html' ? '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' : built.outputFiles.find(f => f.path.endsWith('.' + ext)).contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PMS_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(6000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
  return { page, origin, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
for (const width of [1440, 390]) test(`cashier original intake excludes other household registrations (${width})`, { timeout: 30000 }, async () => {
  const f = await fixture(width); const { page, origin } = f;
  try {
    // Deliberately keep ALL synthetic same-house rows visible. Do not fake a one-row list.
    await page.goto(origin + '/cashier?intakeId=61');
    await page.getByText('已按房屋稳定 ID 定位授权住户。', { exact: false }).waitFor();
    await page.locator('.np-review').first().waitFor();
    assert.equal(await page.locator('.np-review').count(), 1, 'only the requested registration may participate in this deep-link checkout');
    assert.equal(await page.getByRole('button', { name: /^新办车牌（(?:付费|按月收费)）$/ }).count(), 0, 'a focused checkout must not create a second intake');
    assert.equal(await page.getByRole('region', { name: '这一户的车辆列表，可左右滚动查看', exact: true }).count(), 0, 'existing household renewals are outside this focused checkout');
    const pay = page.getByRole('button', { name: /确认收款 ·/ });
    await page.getByRole('button', { name: '现金', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('确认收款 ·') && !b.disabled));
    const before = await page.evaluate(() => window.__calls);
    assert.equal(before.filter(c => c.url === '/business/complete').length, 0);
    assert.equal(before.filter(c => c.url === '/vehicle-intakes').length, 0, 'focused intake loads by ID, not a filtered household list');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(evidence, `focus-ready-${width}.png`), fullPage: true });
    await pay.click();
    await page.getByText('收款已登记', { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.__calls);
    const completes = calls.filter(c => c.url === '/business/complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].data.intakeId, 61);
    assert.equal(completes[0].data.houseId, 501);
    assert.equal(completes[0].data.ownerId, 701);
    assert.equal(calls.some(c => c.url === '/vehicle-intakes' && c.method === 'POST'), false);
    assert.deepEqual(f.errors, []);
    fs.writeFileSync(path.join(evidence, `focus-calls-${width}.json`), JSON.stringify(calls, null, 2));
  } finally { await f.close(); }
});
