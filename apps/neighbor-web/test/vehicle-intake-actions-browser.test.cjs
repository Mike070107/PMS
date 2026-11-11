const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const evidence = path.resolve(app, '../../outputs/vehicle-intake-actions-20261111');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
let built;
async function fixture() {
  built ||= await esbuild.build({ entryPoints: [path.join(__dirname, 'vehicle-intake-actions-fixture.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname, 'vehicle-intake-actions-transport.ts') }, define: { 'import.meta.env.BASE_URL': '"/"', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'local-permission-only', setup(build) {
    build.onResolve({ filter: /^@\/lib\/perm$/ }, a => ({ path: a.path, namespace: 'perm' }));
    build.onLoad({ filter: /.*/, namespace: 'perm' }, () => ({ contents: `export const can=(page,action)=>!new URLSearchParams(location.search).has('readonly');`, loader: 'js' }));
  } }] });
  fs.mkdirSync(evidence, { recursive: true });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/sample.svg')) { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#edf2f8"/><text x="40" y="200" font-size="32">SYNTHETIC SAMPLE ONLY</text></svg>'); return; }
    const ext = req.url === '/fixture.js' ? 'js' : req.url === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8' }[ext]);
    res.end(ext === 'html' ? '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' : built.outputFiles.find(f => f.path.endsWith('.' + ext)).contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PMS_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' }); page.setDefaultTimeout(2500);
  const origin = `http://127.0.0.1:${server.address().port}`; const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
  return { page, origin, errors, close: async () => { assert.deepEqual(errors, [], 'no React runtime errors'); await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
const calls = (page, suffix) => page.evaluate(s => window.__calls.filter(c => c.url.endsWith(s)), suffix);
const rendered = page => page.evaluate(() => window.__rendered);
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function openConversion(page, kind = 'family') { await button(page, kind === 'family' ? '转为亲情车登记' : '转为付费车登记').click(); }
async function confirmConversion(page, relation = '子女') {
  if (await page.getByLabel('转换后与业主关系').count()) await page.getByLabel('转换后与业主关系').fill(relation);
  await page.getByLabel('转换原因').fill('合成回归：纠正登记类型');
  page.once('dialog', d => d.accept()); await button(page, '确认转换登记类型').click();
}
async function voidIntake(page) {
  await button(page, '撤销 / 作废登记').click();
  assert.equal(await button(page, '确认作废').isDisabled(), true);
  await page.getByLabel('作废原因').fill('合成回归：业主取消');
  page.once('dialog', d => d.dismiss()); await button(page, '确认作废').click();
  assert.equal((await calls(page, '/review')).length, 0, 'dismissed confirmation must not cancel');
  page.once('dialog', d => d.accept()); await button(page, '确认作废').click();
}
async function shot(page, name) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); await page.screenshot({ path: path.join(evidence, name + '.png'), fullPage: true }); }

test('known backend finalization and permission restrictions hide impossible actions', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    for (const query of ['?kind=family&status=approved', '?status=approved&txn=awaiting_docs', '?readonly=1']) {
      await page.goto(origin + '/' + query);
      await page.locator('.np-review').waitFor();
      assert.equal(await page.getByRole('button', { name: /转为亲情车登记|转为付费车登记/ }).count(), 0, query);
      assert.equal(await page.getByRole('button', { name: '撤销 / 作废登记', exact: true }).count(), 0, query);
    }
  } finally { await f.close(); }
});

test('waiting cancellation requires reason/confirmation; real response hides QR and public token is invalid', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/?status=waiting'); await page.getByRole('button', { name: '放大扫码登记二维码', exact: true }).waitFor();
    await voidIntake(page); await page.waitForFunction(() => window.__rendered.status === 'void');
    const payload = (await calls(page, '/review')).at(-1); assert.deepEqual(payload.data, { decision: 'void', note: '合成回归：业主取消' });
    assert.equal((await rendered(page)).qrValid, false); assert.match(await page.evaluate(() => window.__probeQr()), /二维码已失效/);
    assert.equal(await page.getByRole('checkbox').count(), 0); assert.equal(await button(page, '放大扫码登记二维码').count(), 0); assert.equal(await page.getByRole('button', { name: /生成二维码|确认转换|撤销 \/ 作废/ }).count(), 0);
    await page.getByText('合成回归：业主取消', { exact: false }).waitFor();
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await shot(page, `waiting-void-${width}`); }
    fs.writeFileSync(path.join(evidence, 'void-response.json'), JSON.stringify({ calls: await calls(page, '/review'), response: await rendered(page) }, null, 2));
  } finally { await f.close(); }
});

test('approved paid to family resets authorization/class, preserves files/contact/log, ignores stale poll, and still requires duplicate check + manager', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.clock.install(); await page.goto(origin + '/?status=approved');
    await page.evaluate(() => { window.__holdPoll = true; }); await page.clock.fastForward(3100); await page.waitForFunction(() => !!window.__releasePoll);
    await openConversion(page); await confirmConversion(page);
    await page.waitForFunction(() => window.__rendered.kind === 'family');
    await page.evaluate(() => { window.__holdPoll = false; window.__releasePoll(); });
    assert.equal((await rendered(page)).status, 'submitted'); assert.equal((await rendered(page)).vehicleClass, '');
    assert.equal((await rendered(page)).files[0].fileName, '合成资料.svg'); assert.equal((await rendered(page)).contactName, '合成联系人');
    assert.equal((await rendered(page)).log.length, 2); assert.deepEqual((await rendered(page)).garages, []);
    assert.deepEqual((await calls(page, '/kind')).at(-1).data, { kind: 'family', relation: '子女', note: '合成回归：纠正登记类型' });
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0); assert.equal(await page.getByLabel('与业主关系', { exact: true }).inputValue(), '子女'); assert.equal((await calls(page, '/garages')).length, 0, 'old type authorization must never auto-POST');
    assert.equal(await button(page, '资料无误，通过').isDisabled(), true);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await shot(page, `converted-family-${width}`); }
    await page.getByRole('checkbox', { name: '二期大车库', exact: true }).check();
    assert.deepEqual(new Set((await calls(page, '/garages')).at(-1).data.garages), new Set(['main', 'phase2']));
    assert.deepEqual((await calls(page, '/garages')).at(-1).data.garageNumbers, {});
    await button(page, '资料无误，通过').click(); await page.waitForFunction(() => window.__rendered.familyCarId === 888);
    assert.equal((await calls(page, '/parking-queries')).length, 1); assert.equal((await calls(page, '/review')).at(-1).data.duplicateCheckQueryId, 901); assert.equal((await calls(page, '/review')).at(-1).data.relation, '子女');
    assert.match(await page.locator('.np-review').innerText(), /等物业经理审核/); assert.notEqual(await page.locator('.np-review-steps li').last().getAttribute('data-state'), 'done');
    fs.writeFileSync(path.join(evidence, 'convert-and-review.json'), JSON.stringify({ calls: await page.evaluate(() => window.__calls), response: await rendered(page) }, null, 2));
  } finally { await f.close(); }
});

test('failed conversion preserves original type, edited fields, pending garage failure, relation/note; pending doubleclick posts once', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/'); await page.getByLabel('车主（选填）').fill('未保存合成输入');
    await page.evaluate(() => { window.__failGarage = true; }); await page.getByRole('checkbox', { name: '地面车库', exact: true }).check(); await page.getByText('合成：授权保存失败', { exact: true }).waitFor();
    await openConversion(page); await page.getByLabel('转换后与业主关系').fill('表姐'); await page.getByLabel('转换原因').fill('保留失败输入');
    await page.evaluate(() => { window.__failKind = true; window.__holdKind = true; }); page.once('dialog', d => d.accept());
    await button(page, '确认转换登记类型').evaluate(b => { b.click(); b.click(); }); await page.waitForFunction(() => !!window.__releaseKind);
    assert.equal((await calls(page, '/kind')).length, 1); assert.equal(await page.getByRole('checkbox').first().isDisabled(), true);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await shot(page, `conversion-pending-${width}`); }
    await page.evaluate(() => window.__releaseKind()); await page.getByText('合成：登记转换失败，请保留输入重试', { exact: true }).waitFor();
    assert.equal((await rendered(page)).kind, 'paid'); assert.equal(await page.getByLabel('转换后与业主关系').inputValue(), '表姐'); assert.equal(await page.getByLabel('转换原因').inputValue(), '保留失败输入'); assert.equal(await page.getByLabel('车主（选填）').inputValue(), '未保存合成输入'); assert.equal(await page.getByRole('checkbox', { name: '地面车库', exact: true }).isChecked(), true);
    await page.clock.install(); await page.clock.fastForward(3100); assert.equal(await page.getByLabel('转换后与业主关系').inputValue(), '表姐'); assert.equal(await page.getByRole('checkbox', { name: '地面车库', exact: true }).isChecked(), true);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await shot(page, `conversion-error-${width}`); }
    await page.evaluate(() => { window.__failKind = false; window.__holdKind = false; }); page.once('dialog', d => d.accept()); await button(page, '确认转换登记类型').click(); await page.waitForFunction(() => window.__rendered.kind === 'family'); assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0); assert.equal(await button(page, '重试保存授权').count(), 0);
  } finally { await f.close(); }
});

test('two-way conversion available before backend finalization; reverse conversion clears old family numbers and never restores old authorization', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    for (const kind of ['paid', 'family']) for (const status of ['waiting', 'submitted', 'reupload', 'approved']) {
      if (kind === 'family' && status === 'approved') continue; // Backend forbids even a missing familyCarId after approval.
      await page.goto(origin + `/?kind=${kind}&status=${status}`);
      await button(page, kind === 'paid' ? '转为亲情车登记' : '转为付费车登记').waitFor(); await button(page, '撤销 / 作废登记').waitFor();
    }
    await page.goto(origin + '/?kind=family&status=submitted');
    await openConversion(page, 'paid'); await confirmConversion(page); await page.waitForFunction(() => window.__rendered.kind === 'paid');
    assert.deepEqual((await rendered(page)).garageNumbers, {}); assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0); assert.equal((await calls(page, '/garages')).length, 0);
    assert.equal(await page.getByRole('link', { name: '去收银台处理此登记', exact: true }).getAttribute('href'), '/cashier?intakeId=61');
  } finally { await f.close(); }
});

test('paid financial linkage forbids conversion; void explicitly does not refund and retains finance; backend refusal retains reason', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/?status=submitted&txn=awaiting_docs'); assert.equal(await button(page, '转为亲情车登记').count(), 0);
    await button(page, '撤销 / 作废登记').click(); await page.getByText(/不会退款.*财务待处理/).waitFor();
    await page.getByLabel('作废原因').fill('保留财务'); await page.evaluate(() => { window.__rejectVoid = '后端真实拒绝示例：原流水已排队，请核对'; }); page.once('dialog', d => d.accept()); await button(page, '确认作废').click();
    await page.getByText('后端真实拒绝示例：原流水已排队，请核对', { exact: true }).waitFor(); assert.equal(await page.getByLabel('作废原因').inputValue(), '保留财务'); assert.equal((await rendered(page)).status, 'submitted');
    await page.evaluate(() => { window.__rejectVoid = ''; }); page.once('dialog', d => d.accept()); await button(page, '确认作废').click(); await page.waitForFunction(() => window.__rendered.status === 'void');
    assert.equal((await rendered(page)).transaction.id, 710); assert.equal((await rendered(page)).transaction.externalSyncStatus, 'manual'); assert.equal((await calls(page, '/refund')).length, 0); assert.equal(await page.getByRole('button', { name: /退款/ }).count(), 0);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); assert.ok((await page.locator('.money').boundingBox()).width > 40, 'finance amount must not collapse into a vertical column'); await shot(page, `paid-void-finance-retained-${width}`); }
    fs.writeFileSync(path.join(evidence, 'paid-void-finance.json'), JSON.stringify({ calls: await page.evaluate(() => window.__calls), response: await rendered(page) }, null, 2));
    for (const txn of ['queued', 'running', 'synced', 'retry', 'failed', 'manual']) { await page.goto(origin + '/?status=approved&txn=' + txn); assert.equal(await button(page, '撤销 / 作废登记').count(), 0); await page.getByText(/车辆管理.*注销/).waitFor(); }
    await page.goto(origin + '/?kind=family&status=approved&linked=1'); assert.equal(await button(page, '撤销 / 作废登记').count(), 0); assert.equal(await button(page, '转为付费车登记').count(), 0); await page.getByText(/亲情车管理/).waitFor();
  } finally { await f.close(); }
});

test('converted family cannot bypass relation or failed duplicate lookup; business edit controls conversion only', async () => {
  const f = await fixture(); const { page, origin } = f;
  try {
    await page.goto(origin + '/'); await openConversion(page); assert.equal(await button(page, '确认转换登记类型').isDisabled(), true); await confirmConversion(page); await page.waitForFunction(() => window.__rendered.kind === 'family');
    await page.getByRole('checkbox', { name: '一期地面', exact: true }).check(); await page.getByLabel('与业主关系', { exact: true }).selectOption(''); assert.equal(await button(page, '资料无误，通过').isDisabled(), true);
    await page.getByLabel('与业主关系', { exact: true }).selectOption('子女'); await page.evaluate(() => { window.__failQuery = true; }); await button(page, '资料无误，通过').click(); await page.getByText('合成：旧库查重失败，不能通过', { exact: true }).waitFor(); assert.equal((await calls(page, '/review')).length, 0);
    await page.goto(origin + '/?readonly=1'); assert.equal(await button(page, '转为亲情车登记').count(), 0); assert.equal((await calls(page, '/kind')).length, 0);
  } finally { await f.close(); }
});
