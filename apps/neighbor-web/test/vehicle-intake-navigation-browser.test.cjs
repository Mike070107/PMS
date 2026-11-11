const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const evidence = path.resolve(app, '../../outputs/vehicle-intake-navigation-20261111');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
let built;
async function fixture(width = 1440) {
  built ||= await esbuild.build({ entryPoints: [path.join(__dirname, 'vehicle-intake-navigation-fixture.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname, 'vehicle-intake-navigation-transport.ts'), '@pms/shared-types': path.resolve(app, '../../packages/shared-types/src/index.ts') }, define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_LEGACY_BASE': '""', 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'only-auth-and-permission', setup(build) {
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
  page.setDefaultTimeout(4000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
  return { page, origin, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
const calls = page => page.evaluate(() => window.__calls);
const navigate = (page, url) => page.evaluate(url => window.__navigate(url), url);
async function shot(page, name) { await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true }); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'page must not overflow at narrow width'); }
async function openCreation(page, kind = 'paid') {
  await page.getByRole('button', { name: '新车登记', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新车登记', exact: true });
  await dialog.locator('.ant-select-selector').click();
  await page.locator('.ant-cascader-menu-item').filter({ hasText: '合成小区' }).click();
  await page.locator('.ant-cascader-menu-item').filter({ hasText: '8号' }).click();
  await page.locator('.ant-cascader-menu-item').filter({ hasText: '901' }).click();
  if (kind === 'family') await dialog.getByRole('button', { name: '亲情车（免费 · 一年）', exact: true }).click();
  return dialog;
}
async function create(page, kind = 'paid') {
  const dialog = await openCreation(page, kind);
  await dialog.getByRole('button', { name: '生成二维码让业主填', exact: true }).click();
  await dialog.getByRole('img', { name: '登记二维码', exact: true }).waitFor();
  return dialog;
}

test('precise intake links open waiting registration instead of hiding it behind submitted filter', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/plates?intakeId=61');
    await page.getByRole('heading', { name: '车牌登记审核', exact: true }).waitFor();
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
    await page.getByRole('region', { name: '本次登记 #61' }).waitFor();
    assert.ok((await calls(page)).some(c => c.url === '/vehicle-intakes/61'));
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

test('creation in flight locks household and type and collapses double-clicks', { timeout: 12000 }, async () => {
  const f = await fixture(390); const { page, origin } = f;
  try {
    await page.goto(origin + '/vehicles');
    const dialog = await openCreation(page);
    await page.evaluate(() => { window.__waitFor = ['POST /vehicle-intakes']; });
    await dialog.getByRole('button', { name: '生成二维码让业主填', exact: true }).evaluate(b => { b.click(); b.click(); });
    await page.waitForFunction(() => !!window.__holds['POST /vehicle-intakes']);
    assert.equal(await dialog.getByRole('button', { name: '亲情车（免费 · 一年）', exact: true }).isDisabled(), true);
    assert.ok(await dialog.locator('.ant-select-disabled').count());
    assert.equal((await calls(page)).filter(c => c.url === '/vehicle-intakes' && c.method === 'POST').length, 1);
    await page.evaluate(() => { window.__waitFor = []; window.__release('POST /vehicle-intakes'); });
    await dialog.getByRole('img', { name: '登记二维码', exact: true }).waitFor();
    assert.equal((await calls(page)).find(c => c.url === '/vehicle-intakes' && c.method === 'POST').data.kind, 'paid');
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

test('payment preflight rejects a registration changed to paid or family after navigation; transport failure retains cart', { timeout: 30000 }, async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/vehicles');
    await navigate(page, '/cashier?intakeId=61');
    await page.getByRole('button', { name: '现金', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('确认收款 ·') && !b.disabled));
    await page.evaluate(() => { window.__failures['POST /business/complete'] = '合成网络失败，保留原登记和收费选择'; });
    await page.getByRole('button', { name: /确认收款 ·/ }).click();
    await page.getByText('合成网络失败，保留原登记和收费选择', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: /确认收款 ·/ }).isDisabled(), false);
    assert.ok((await page.locator('.cartFoot').innerText()).includes('现金'));
    await page.evaluate(() => { delete window.__failures['POST /business/complete']; window.__intakes[61].transaction = { ...window.__intakes[65].transaction }; });
    await page.getByRole('button', { name: /确认收款 ·/ }).click();
    await page.getByRole('region', { name: '本次登记 #61' }).getByText('已收款 ·', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: /确认收款 ·/ }).isDisabled(), true);
    assert.equal((await calls(page)).filter(c => c.url === '/business/complete').length, 1, 'preflight must stop a second payment attempt');
    await navigate(page, '/cashier');
    await page.evaluate(() => { window.__intakes[61].transaction = null; });
    await navigate(page, '/cashier?intakeId=61');
    await page.getByRole('button', { name: '现金', exact: true }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('确认收款 ·') && !b.disabled));
    await page.evaluate(() => { window.__intakes[61].kind = 'family'; });
    await page.getByRole('button', { name: /确认收款 ·/ }).click();
    await page.getByText('本次为免费亲情车，无需收费', { exact: false }).waitFor();
    assert.equal((await calls(page)).filter(c => c.url === '/business/complete').length, 1, 'converted family is never submitted to payment');
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

for (const width of [1440, 390]) {
  test(`real creation -> original intake cart -> explicit payment (${width})`, { timeout: 30000 }, async () => {
    const f = await fixture(width); const { page, origin } = f;
    try {
      await page.goto(origin + '/vehicles');
      const dialog = await create(page);
      assert.equal(await dialog.getByRole('button', { name: '新办车牌（按月收费）', exact: true }).count(), 0, 'type locked after create');
      await shot(page, `vehicles-created-${width}`); await noOverflow(page);
      await page.evaluate(() => { window.__waitFor = ['GET /vehicle-intakes/71']; });
      await dialog.getByRole('button', { name: '去收银台收费', exact: true }).click();
      assert.ok(page.url().endsWith('/cashier?intakeId=71'));
      await page.getByText('正在安全定位本次登记所属住户…', { exact: true }).waitFor();
      await shot(page, `cashier-waiting-${width}`); await noOverflow(page);
      assert.equal((await calls(page)).filter(c => c.url === '/business/complete').length, 0);
      await page.waitForFunction(() => !!window.__holds['GET /vehicle-intakes/71']);
      await page.evaluate(() => { window.__waitFor = []; window.__release('GET /vehicle-intakes/71'); });
      await page.getByText('已按房屋稳定 ID 定位授权住户。', { exact: false }).waitFor();
      await page.getByRole('button', { name: /确认收款 ·/ }).waitFor();
      await page.waitForFunction(() => window.__calls.some(c => c.url === '/business/estimate'));
      const payButton = page.getByRole('button', { name: /确认收款 ·/ });
      await page.getByRole('button', { name: '现金', exact: true }).click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('确认收款 ·') && !b.disabled));
      await shot(page, `cashier-ready-${width}`); await noOverflow(page);
      assert.equal((await calls(page)).filter(c => c.url === '/business/complete').length, 0, 'never auto-pay');
      await payButton.click();
      await page.getByText('收款已登记', { exact: true }).waitFor();
      await shot(page, `cashier-success-${width}`); await noOverflow(page);
      const log = await calls(page);
      const payload = log.find(c => c.url === '/business/complete');
      assert.equal(payload.data.intakeId, 71, 'cart preserves the exact create intake ID');
      assert.equal(payload.data.houseId, 501); assert.equal(payload.data.ownerId, 701);
      assert.equal(log.filter(c => c.url === '/vehicle-intakes' && c.method === 'POST').length, 1, 'no second create');
      assert.equal(log.some(c => c.url === '/business/search'), false, 'no label parsing / guessed-owner search');
      assert.equal(f.errors.length, 0, f.errors.join('\n'));
      fs.writeFileSync(path.join(evidence, `payment-calls-${width}.json`), JSON.stringify(log, null, 2));
    } finally { await f.close(); }
  });

  test(`creation cancellation retains QR and reason on failure; family uses exact detail link (${width})`, { timeout: 25000 }, async () => {
    const f = await fixture(width); const { page, origin } = f;
    try {
      await page.goto(origin + '/vehicles');
      const dialog = await create(page, 'family');
      assert.equal(await dialog.getByRole('button', { name: '去收银台收费', exact: true }).count(), 0);
      const cancel = dialog.getByRole('button', { name: '撤销本次登记', exact: true });
      assert.equal(await cancel.isDisabled(), true);
      await dialog.getByLabel('撤销原因', { exact: true }).fill('合成撤销原因：登记重复，保留审计');
      assert.equal(await cancel.isDisabled(), true);
      await dialog.getByRole('checkbox', { name: '确认撤销本次登记，原二维码将失效', exact: true }).check();
      await page.evaluate(() => { window.__failures['POST /vehicle-intakes/71/review'] = '合成服务端拒绝：原状态已变化'; });
      await cancel.click();
      await dialog.getByText('合成服务端拒绝：原状态已变化', { exact: true }).waitFor();
      assert.equal(await dialog.getByLabel('撤销原因', { exact: true }).inputValue(), '合成撤销原因：登记重复，保留审计');
      assert.equal(await dialog.getByRole('img', { name: '登记二维码' }).count(), 1);
      assert.equal(await dialog.getByRole('checkbox').isChecked(), true);
      await shot(page, `vehicles-void-error-${width}`); await noOverflow(page);
      await page.evaluate(() => { delete window.__failures['POST /vehicle-intakes/71/review']; });
      await cancel.click();
      await dialog.getByText('已撤销，原二维码已失效。', { exact: false }).waitFor();
      assert.equal(await dialog.getByRole('img', { name: '登记二维码' }).count(), 0);
      const voidCalls = (await calls(page)).filter(c => c.url === '/vehicle-intakes/71/review');
      assert.equal(voidCalls.length, 2); assert.deepEqual(voidCalls[1].data, { decision: 'void', note: '合成撤销原因：登记重复，保留审计' });
      assert.equal((await calls(page)).some(c => c.method === 'DELETE'), false);
      await shot(page, `vehicles-void-success-${width}`);
      await dialog.getByRole('button', { name: '查看/处理本次登记', exact: true }).click();
      const region = page.getByRole('region', { name: '本次登记 #71', exact: true });
      await region.getByText('已作废', { exact: true }).first().waitFor();
      assert.ok(page.url().endsWith('/plates?intakeId=71'));
      assert.equal(f.errors.length, 0, f.errors.join('\n'));
    } finally { await f.close(); }
  });

  test(`scoped deep links, visible errors, actual lifecycle and stale query results (${width})`, { timeout: 45000 }, async () => {
    const f = await fixture(width); const { page, origin } = f;
    try {
      await page.goto(origin + '/vehicles');
      await page.evaluate(() => { window.__waitFor = ['GET /vehicle-intakes/61']; });
      await navigate(page, '/plates?id=61');
      await page.waitForFunction(() => !!window.__holds['GET /vehicle-intakes/61']);
      await shot(page, `plates-waiting-${width}`); await noOverflow(page);
      await navigate(page, '/plates?intakeId=62');
      const focused = page.getByRole('region', { name: '本次登记 #62', exact: true });
      await focused.getByText('浙ADD422', { exact: false }).first().waitFor();
      await page.evaluate(() => { window.__waitFor = []; window.__release('GET /vehicle-intakes/61'); });
      assert.equal(await page.getByRole('region', { name: '本次登记 #61', exact: true }).count(), 0);
      await shot(page, `plates-approved-${width}`); await noOverflow(page);
      assert.ok((await page.getByRole('heading', { name: '车牌登记审核', exact: true }).boundingBox()).height < 60, 'search form must wrap below heading, not squeeze it into a vertical column');
      await page.evaluate(() => { window.__failures['GET /vehicle-intakes'] = '合成列表网络错误，不能当作空列表'; window.__failures['GET /vehicle-intakes/70'] = '合成租户拒绝访问'; });
      await page.getByRole('button', { name: '等业主填写', exact: true }).click();
      await page.getByText('登记列表：合成列表网络错误，不能当作空列表', { exact: true }).waitFor();
      await focused.getByText('浙ADD422', { exact: false }).first().waitFor();
      await navigate(page, '/plates?intakeId=70');
      await page.getByText('合成租户拒绝访问', { exact: true }).waitFor();
      await shot(page, `plates-error-${width}`); await noOverflow(page);
      await page.evaluate(() => { window.__failures = {}; window.__waitFor = ['GET /vehicle-intakes/61']; });
      await navigate(page, '/cashier?intakeId=61');
      await page.waitForFunction(() => !!window.__holds['GET /vehicle-intakes/61']);
      await navigate(page, '/cashier?intakeId=62');
      await page.getByRole('region', { name: '本次登记 #62' }).getByText('浙ADD422', { exact: true }).waitFor();
      await page.evaluate(() => { window.__waitFor = []; window.__release('GET /vehicle-intakes/61'); });
      assert.equal(await page.getByRole('region', { name: '本次登记 #61' }).count(), 0);
      assert.equal((await calls(page)).some(c => c.url === '/vehicle-intakes' && c.query?.houseId === 501), false, 'late query cannot mount wrong household');
      const cases = [
        ['0', '登记编号必须是正整数'], ['-1', '登记编号必须是正整数'], ['1.5', '登记编号必须是正整数'], ['9007199254740992', '登记编号必须是正整数'],
        ['70', '登记不存在或不在当前租户授权范围'], ['66', '本次登记所属房屋不在当前授权地址范围，无法收费'], ['69', '登记返回的编号或房屋编号无效'],
        ['63', '本次为免费亲情车，无需收费'], ['64', '本次登记已撤销，不能收费。'], ['65', '已收款 ·'], ['68', '已转亲情车办理，不再按付费新车收款。'], ['67', '原二维码已失效；']
      ];
      for (const [id, text] of cases) {
        await navigate(page, '/cashier?intakeId=' + id + '&houseId=999');
        await page.getByRole('region', { name: '本次登记 #' + id, exact: true }).getByText(text, { exact: false }).first().waitFor();
        if (['63','64','65','68'].includes(id)) {
          assert.equal(await page.getByRole('button', { name: /确认收款 ·/ }).isDisabled(), true);
          assert.equal(await page.getByRole('button', { name: '新办车牌（按月收费）', exact: true }).count(), 0);
        }
        await noOverflow(page);
      }
      await navigate(page, '/cashier?intakeId=66');
      await page.getByText('本次登记所属房屋不在当前授权地址范围，无法收费', { exact: true }).waitFor();
      await shot(page, `cashier-error-${width}`);
      const log = await calls(page);
      assert.equal(log.filter(c => c.url === '/business/complete').length, 0);
      assert.equal(log.some(c => c.url === '/business/search' || /^\/houses\//.test(c.url)), false);
      assert.equal(log.some(c => /vehicle-intakes\/(0|-1|1.5|9007199254740992)$/.test(c.url)), false, 'invalid IDs rejected before transport');
      assert.equal(f.errors.length, 0, f.errors.join('\n'));
    } finally { await f.close(); }
  });
}
