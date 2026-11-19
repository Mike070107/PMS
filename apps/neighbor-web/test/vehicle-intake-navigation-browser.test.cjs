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
  built ||= await esbuild.build({ entryPoints: [path.join(__dirname, 'vehicle-intake-navigation-fixture.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname, 'vehicle-intake-navigation-transport.ts'), '@pms/shared-types': path.resolve(app, '../../packages/shared-types/src/index.ts') }, define: { 'import.meta.env.VITE_API_BASE_URL': '"/api/v1"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_LEGACY_BASE': '""', 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'only-auth-and-permission', setup(build) {
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
async function shot(page, name) { await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true, animations: 'disabled' }); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'page must not overflow at narrow width'); }
async function openCreation(page, kind = 'paid') {
  await page.getByRole('button', { name: '新车登记', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新车登记', exact: true });
  await dialog.locator('.ant-select-selector').click();
  await page.locator('.ant-cascader-menu-item[data-path-key="1"]').click();
  await page.locator('.ant-cascader-menu-item[data-path-key="1__RC_CASCADER_SPLIT__11"]').click();
  await page.locator('.ant-cascader-menu-item').filter({ hasText: '901' }).click();
  if (kind === 'family') await dialog.getByRole('button', { name: '亲情车（免费）', exact: true }).click();
  return dialog;
}
async function create(page, kind = 'paid') {
  const dialog = await openCreation(page, kind);
  await dialog.getByRole('button', { name: '工作人员直接登记', exact: true }).click();
  await dialog.getByLabel('车牌号码（必填）').waitFor();
  return dialog;
}

for (const width of [1440, 390]) test(`Vehicles unique query household prefills registration with stable ID (${width})`, async () => {
  const f = await fixture(width); const { page, origin } = f;
  try {
    await page.goto(origin + '/vehicles');
    await page.evaluate(() => { window.__queryResults = { '198/8/901': { rows: ['parking1', 'parking2'].map(database => ({ database, fields: { CarNo: '浙ADD422' }, pmsMatch: { houseId: 501, userId: 701, name: '合成住户', matchedBy: 'room' } })) } }; });
    const search = page.locator('.hsearch input');
    await search.fill('198/8/901'); await search.press('Enter');
    await page.getByText(/查询「198\/8\/901」/).waitFor();
    await page.getByRole('button', { name: '新车登记', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新车登记', exact: true });
    assert.match(await dialog.locator('.ant-select-selector').innerText(), /901/);
    assert.equal(await dialog.getByRole('button', { name: '工作人员直接登记', exact: true }).isDisabled(), false);
    await shot(page, `vehicles-prefilled-${width}`); await noOverflow(page);
    await dialog.getByRole('button', { name: '工作人员直接登记', exact: true }).click();
    await dialog.getByLabel('车牌号码（必填）').waitFor();
    assert.equal((await calls(page)).find(c => c.url === '/vehicle-intakes' && c.method === 'POST').data.houseId, 501);
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

test('Vehicles ambiguous, unmatched, stale, failed and out-of-scope queries never preselect a household', { timeout: 30000 }, async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/vehicles');
    for (const scenario of ['multiple', 'missing', 'outside', 'mismatch', 'disabled', 'failed', 'edited']) {
      await page.evaluate(scenario => {
        const ids = scenario === 'multiple' ? [501, 502] : [scenario === 'outside' ? 999 : 501];
        window.__queryResults = { [scenario]: { status: scenario === 'failed' ? 'failed' : 'completed', rows: ids.map((houseId, i) => ({ database: 'parking1', fields: { CarNo: '浙ADD42' + i }, pmsMatch: scenario === 'missing' ? null : { houseId, userId: 701, name: '合成住户', matchedBy: 'room', ...(scenario === 'disabled' ? { status: 'disabled' } : {}), ...(scenario === 'mismatch' ? { house: { id: 502 } } : {}) } })) } };
      }, scenario);
      const search = page.locator('.hsearch input');
      await search.fill(scenario); await search.press('Enter');
      await page.getByText(`查询「${scenario}」`, { exact: false }).waitFor();
      if (scenario === 'edited') await search.fill('尚未查询的其他住户');
      await page.getByRole('button', { name: '新车登记', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新车登记', exact: true });
      assert.equal(await dialog.getByRole('button', { name: '工作人员直接登记', exact: true }).isDisabled(), true, scenario);
      await dialog.getByRole('button', { name: /关闭/ }).click();
    }
    assert.equal((await calls(page)).filter(c => c.url === '/vehicle-intakes' && c.method === 'POST').length, 0);
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

test('Vehicles pending result does not overwrite manual household selection', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/vehicles');
    await page.evaluate(() => { window.__queryResults = { '198/8/902': { rows: [{ database: 'parking1', fields: { CarNo: '浙ADD422' }, pmsMatch: { houseId: 502, userId: 702, matchedBy: 'room' } }] } }; window.__waitFor = ['GET /mock/parking-query/198/8/902']; });
    await page.locator('.hsearch input').fill('198/8/902'); await page.locator('.hsearch input').press('Enter');
    await page.waitForFunction(() => !!window.__holds['GET /mock/parking-query/198/8/902']);
    const dialog = await openCreation(page);
    await page.evaluate(() => { window.__waitFor = []; window.__release('GET /mock/parking-query/198/8/902'); });
    await page.getByText(/查询「198\/8\/902」/).waitFor();
    assert.match(await dialog.locator('.ant-select-selector').innerText(), /901/);
    await dialog.getByRole('button', { name: /关闭/ }).click();
    await page.getByRole('button', { name: '新车登记', exact: true }).click();
    assert.match(await dialog.locator('.ant-select-selector').innerText(), /902/);
    await dialog.locator('.ant-select-selector').click();
    await page.locator('.ant-cascader-menu-item').filter({ hasText: '901' }).click();
    assert.match(await dialog.locator('.ant-select-selector').innerText(), /901/);
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

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
    await dialog.getByRole('button', { name: '工作人员直接登记', exact: true }).evaluate(b => { b.click(); b.click(); });
    await page.waitForFunction(() => !!window.__holds['POST /vehicle-intakes']);
    assert.equal(await dialog.getByRole('button', { name: '亲情车（免费）', exact: true }).isDisabled(), true);
    assert.ok(await dialog.locator('.ant-select-disabled').count());
    assert.equal((await calls(page)).filter(c => c.url === '/vehicle-intakes' && c.method === 'POST').length, 1);
    await page.evaluate(() => { window.__waitFor = []; window.__release('POST /vehicle-intakes'); });
    await dialog.getByLabel('车牌号码（必填）').waitFor();
    assert.equal((await calls(page)).find(c => c.url === '/vehicle-intakes' && c.method === 'POST').data.kind, 'paid');
    assert.equal(f.errors.length, 0, f.errors.join('\n'));
  } finally { await f.close(); }
});

test('payment preflight rejects a registration changed to paid or family after navigation; transport failure retains cart', { timeout: 30000 }, async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/vehicles');
    await page.evaluate(() => { Object.assign(window.__intakes[61], { status: 'approved', plate: '沪A12345', submittedAt: '2026-11-17T09:00:00Z', reviewedAt: '2026-11-17T09:01:00Z' }); });
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
    await page.evaluate(() => { Object.assign(window.__intakes[61], { status: 'approved', plate: '沪A12345', submittedAt: '2026-11-17T09:00:00Z', reviewedAt: '2026-11-17T09:01:00Z' }); });
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
      assert.ok(page.url().endsWith('/vehicles'), 'registration and payment stay inside Vehicles');
      assert.equal(await dialog.getByRole('button', { name: '去收银台收费', exact: true }).count(), 0);
      assert.equal((await calls(page)).filter(c => c.url === '/business/complete').length, 0);
      assert.equal(await dialog.locator('.cart2').count(),0);
      await dialog.getByRole('button',{ name:'保存登记，继续授权' }).click();
      assert.equal(await dialog.getByLabel('车牌号码（必填）',{exact:false}).getAttribute('aria-invalid'),'true');
      await dialog.getByLabel('车牌号码（必填）',{exact:false}).fill('沪A12345');
      await page.getByLabel('联系手机（必填）').fill('13900000000');
      await page.getByRole('button', { name: '保存登记，继续授权', exact: true }).click();
      await page.getByRole('button', { name: '资料无误，通过', exact: true }).click();
      await page.waitForFunction(() => window.__calls.some(c => c.url === '/business/estimate'));
      const payButton = page.getByRole('button', { name: /确认收款 ·/ });
      await page.getByRole('button', { name: '现金', exact: true }).click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('确认收款 ·') && !b.disabled));
      await shot(page, `cashier-ready-${width}`); await noOverflow(page);
      assert.equal((await calls(page)).filter(c => c.url === '/business/complete').length, 0, 'never auto-pay');
      await page.evaluate(() => { window.__waitFor = ['POST /business/complete']; });
      await payButton.click();
      await page.waitForFunction(() => !!window.__holds['POST /business/complete']);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent === '再登记一台' && b.disabled));
      assert.equal(await dialog.getByRole('button', { name: '再登记一台', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.isVisible(), true, 'cannot close and lose payment result while submitting');
      await page.evaluate(() => { window.__waitFor = []; window.__release('POST /business/complete'); });
      await page.getByText('收款已登记', { exact: true }).waitFor();
      assert.ok(page.url().endsWith('/vehicles'), 'payment result remains in original Vehicles sheet');
      assert.equal(await dialog.getByRole('button', { name: '换一户', exact: true }).count(), 0);
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

  test(`inline family cancellation retains QR and reason on failure and never navigates (${width})`, { timeout: 25000 }, async () => {
    const f = await fixture(width); const { page, origin } = f;
    try {
      await page.goto(origin + '/vehicles');
      const dialog = await create(page, 'family');
      assert.equal(await dialog.getByRole('button', { name: '去收银台收费', exact: true }).count(), 0);
      assert.equal(await dialog.locator('.cart2').count(),0);
      await shot(page, `family-registration-${width}`);
      await dialog.getByRole('button',{name:'改由住户扫码'}).click();
      await dialog.getByRole('img',{name:'扫码填写',exact:true}).waitFor();
      await dialog.getByRole('button', { name: '撤销 / 作废登记', exact: true }).click();
      const cancel = dialog.getByRole('button', { name: '确认作废', exact: true });
      assert.equal(await cancel.isDisabled(), true);
      await dialog.getByLabel('作废原因', { exact: true }).fill('合成撤销原因：登记重复，保留审计');
      page.on('dialog', d => d.accept());
      await page.evaluate(() => { window.__failures['POST /vehicle-intakes/71/review'] = '合成服务端拒绝：原状态已变化'; });
      await cancel.click();
      await dialog.getByText('合成服务端拒绝：原状态已变化', { exact: true }).waitFor();
      assert.equal(await dialog.getByLabel('作废原因', { exact: true }).inputValue(), '合成撤销原因：登记重复，保留审计');
      assert.equal(await dialog.getByRole('img', { name: '扫码填写' }).count(), 1);
      assert.equal(await dialog.getByRole('button', { name: /确认收款 ·/ }).count(), 0, 'family intake cannot charge');
      await shot(page, `vehicles-void-error-${width}`); await noOverflow(page);
      await page.evaluate(() => { delete window.__failures['POST /vehicle-intakes/71/review']; });
      await cancel.click();
      await dialog.getByText('已作废', { exact: true }).first().waitFor();
      assert.equal(await dialog.getByRole('img', { name: '扫码填写' }).count(), 0);
      const voidCalls = (await calls(page)).filter(c => c.url === '/vehicle-intakes/71/review');
      assert.equal(voidCalls.length, 2); assert.deepEqual(voidCalls[1].data, { decision: 'void', note: '合成撤销原因：登记重复，保留审计' });
      assert.equal((await calls(page)).some(c => c.method === 'DELETE'), false);
      await shot(page, `vehicles-void-success-${width}`);
      const region = page.getByRole('region', { name: '本次登记 #71', exact: true });
      await region.getByText('已作废', { exact: true }).first().waitFor();
      assert.ok(page.url().endsWith('/vehicles'), 'family cancellation stays in original dialog');
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
