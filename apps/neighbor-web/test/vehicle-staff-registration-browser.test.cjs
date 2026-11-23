const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..');
const out = path.resolve(app, '../../outputs/vehicle-registration-20261117');
let built;
async function fixture(width) {
  built ||= await esbuild.build({ entryPoints: [path.join(__dirname, 'vehicle-staff-registration-fixture.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname, 'vehicle-staff-registration-transport.ts') }, define: { 'import.meta.env.BASE_URL': '"/"', 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'synthetic-permission', setup(build) { build.onResolve({ filter: /^@\/lib\/perm$/ }, a => ({ path: a.path, namespace: 'perm' })); build.onLoad({ filter: /.*/, namespace: 'perm' }, () => ({ contents: 'export const can=()=>true;', loader: 'js' })); } }] });
  const server = http.createServer((req, res) => {
    if (req.url === '/sample.png') { res.setHeader('Content-Type', 'image/png'); res.end(fs.readFileSync(path.join(__dirname, 'fixtures/work-order-media/sample.png'))); return; }
    const ext = req.url === '/fixture.js' ? 'js' : req.url === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8' }[ext]);
    res.end(ext === 'html' ? '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' : built.outputFiles.find(f => f.path.endsWith('.' + ext)).contents);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width, height: 950 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
  fs.mkdirSync(out, { recursive: true }); await page.goto(origin);
  return { page, errors, close: async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); assert.deepEqual(errors, []); } };
}
const button = (p, name) => p.getByRole('button', { name, exact: true });
async function screenshot(page, name) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow'); await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); }
test('已有登记时保留输入并给出原车续费和收款流水入口', { timeout: 60000 }, async () => {
  const f = await fixture(375); const p = f.page;
  try {
    await button(p, '工作人员直接代填').click();
    await button(p, '点选车牌').click();
    for (const key of '沪A12345') await p.locator('.intake-plate-keys').getByRole('button', { name: key, exact: true }).click();
    await p.getByLabel('本车联系手机（必填）').fill('13711112222');
    await p.evaluate(() => { window.__existingPlate = true; });
    await button(p, '保存资料，进入预览').click();
    const renew = p.getByRole('link', { name: '按原车续费' });
    const records = p.getByRole('link', { name: '查看收款流水' });
    await renew.waitFor();
    assert.equal(new URL(await renew.getAttribute('href'), p.url()).searchParams.get('renewPlate'), '沪A12345');
    assert.equal(new URL(await records.getAttribute('href'), p.url()).searchParams.get('q'), '沪A12345');
    assert.equal(await p.getByLabel('本车联系手机（必填）').inputValue(), '13711112222');
    assert.equal(await p.evaluate(() => window.__current().status), 'waiting');
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.url === '/business/complete')), false);
    await screenshot(p, 'existing-plate-renewal-375.png');
  } finally { await f.close(); }
});
test('原登记已红冲且未入库时解除占用并在原表单保存', { timeout: 60000 }, async () => {
  const f = await fixture(375); const p = f.page;
  try {
    await button(p, '工作人员直接代填').click();
    await button(p, '点选车牌').click();
    for (const key of '沪A12345') await p.locator('.intake-plate-keys').getByRole('button', { name: key, exact: true }).click();
    await p.getByLabel('本车联系手机（必填）').fill('13711112222');
    await p.evaluate(() => { window.__existingPlate = true; window.__reversedIntake = true; });
    await button(p, '保存资料，进入预览').click();
    const release = button(p, '解除原登记占用');
    await release.waitFor();
    assert.equal(await release.isDisabled(), true);
    assert.equal(await p.getByRole('link', { name: '查看原登记' }).getAttribute('href'), '/plates?intakeId=70');
    assert.equal(await p.getByRole('link', { name: '按原车续费' }).count(), 0);
    await screenshot(p, 'reversed-registration-release-375.png');
    await p.getByLabel('已核对原车库，确认该车牌未入库').check();
    await release.click();
    await p.getByText('请重新保存本次资料。', { exact: false }).waitFor();
    assert.equal(await p.getByLabel('本车联系手机（必填）').inputValue(), '13711112222');
    await button(p, '保存资料，进入预览').click();
    await p.waitForFunction(() => window.__current().status === 'submitted');
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.url === '/business/complete')), false);
  } finally { await f.close(); }
});
for (const width of [1440, 375]) test(`staff no-attachment registration + garage failure/retry + actual inline CarRenewal ${width}px`, { timeout: 60000 }, async () => {
  const f = await fixture(width); const p = f.page;
  try {
    await button(p, '工作人员直接代填').click();
    assert.equal(await button(p, '保存登记，继续授权').isDisabled(), true);
    await p.getByRole('button', { name: '点选车牌', exact: true }).click();
    for (const key of '沪A12345') await p.locator('.intake-plate-keys').getByRole('button', { name: key, exact: true }).click();
    assert.equal(await p.getByLabel('本车联系手机（必填）').inputValue(), '', 'owner phone must not be silently reused');
    await p.getByLabel('本车联系手机（必填）').fill('13711112222');
    assert.equal(await p.locator('.np-grid .intake-registration-form').count(), 0, 'staff card is independent from QR grid');
    const category = p.getByRole('group', { name: '车辆类别', exact: true });
    for (const label of ['租户车2','住户车1','产权车','亲情车']) assert.equal(await category.getByRole('radio',{name:label,exact:true}).count(),1);
    const positions = await category.locator('label').filter({hasText:/住户车[123]/}).evaluateAll(labels => labels.map(label => label.offsetTop));
    assert.equal(new Set(positions).size,1,'three resident classes share one row');
    await category.screenshot({path:path.join(out, 'vehicle-types-' + width + '.png')});
    const rows = await category.locator('.vehicle-class-group').evaluateAll(groups => groups.map(group => group.getBoundingClientRect().top));
    assert.equal(new Set(rows).size, rows.length, 'one row per class');
    await category.getByRole('radio',{name:'产权车',exact:true}).check();
    await p.waitForFunction(() => window.__rendered.vehicleClass === '产权车位');
    assert.equal(await category.locator('input:checked').count(),1);

    await category.getByRole('radio',{name:'租户车2'}).check(); await p.waitForFunction(() => window.__rendered.vehicleClass === '租户车-2');
    assert.equal(await category.getByRole('radio',{name:'产权车',exact:true}).isChecked(),false);
    assert.equal(await category.locator('input:checked').count(),1);
    await category.getByRole('radio',{name:'住户车1'}).check(); await p.waitForFunction(() => window.__rendered.vehicleClass === '住户车-1');
    assert.equal(await button(p, '保存登记，继续授权').isEnabled(), true);
    await screenshot(p, `staff-optional-${width}.png`);
    await p.evaluate(() => { window.__holdSubmit = true; });
    await button(p, '保存登记，继续授权').click(); await button(p, '保存中…').waitFor();
    assert.equal(await button(p, '保存中…').isDisabled(), true);
    await screenshot(p, `staff-waiting-${width}.png`);
    await p.evaluate(() => window.__releaseSubmit()); await p.waitForFunction(() => window.__rendered.status === 'submitted');
    assert.equal(await p.evaluate(() => window.__rendered.files.length), 0);
    await p.getByRole('checkbox', { name: '大车库', exact: true }).click();
    const dialog = p.getByRole('dialog'); await dialog.waitFor();
    assert.equal(await dialog.getByRole('radio', { name: 'B123456 · 车位档案需先核对', exact: true }).isDisabled(), true);
    const geometry = await dialog.locator('.garage-space-tile').evaluateAll(els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, icon: !!el.querySelector('svg use') })));
    assert.equal(geometry.length, 2); assert.ok(geometry.every(g => g.icon && g.height === geometry[0].height && Math.abs(g.width - geometry[0].width) < 1));
    await dialog.screenshot({ path: path.join(out, `uniform-spaces-${width}.png`), animations: 'disabled' });
    await dialog.getByRole('radio', { name: 'B12', exact: true }).check();
    await p.evaluate(() => { window.__failGarage = true; }); await dialog.getByRole('button', { name: '确认车位', exact: true }).click();
    const space = p.getByRole('button', { name: /B12.*更换/ });
    await p.getByText('合成：授权保存失败，输入已保留', { exact: true }).waitFor();
    assert.match(await space.textContent(), /B12/); assert.equal(await p.evaluate(() => window.__rendered.plate), '沪A12345');
    await screenshot(p, `garage-error-${width}.png`);
    await p.evaluate(() => { window.__failGarage = false; }); await button(p, '重试保存授权').click();
    await p.waitForFunction(() => window.__rendered.garageNumbers.main === 'B12');
    await p.getByRole('checkbox', { name: '大车库', exact: true }).uncheck();
    await p.waitForFunction(() => !window.__rendered.garageNumbers.main);
    await p.getByRole('checkbox', { name: '大车库', exact: true }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('radio', { name: 'B12', exact: true }).isChecked(), false, 'removed channel invalidates the prior garage selection');
    await dialog.getByRole('radio', { name: 'B12', exact: true }).check();
    await dialog.getByRole('button', { name: '确认车位', exact: true }).click();
    await p.waitForFunction(() => window.__rendered.garageNumbers.main === 'B12');
    await p.evaluate(() => { window.__failReview = true; }); await button(p, '资料无误，通过').click();
    await p.getByText('合成：车位已关联其他车辆或房号，不能抢占', { exact: true }).waitFor();
    assert.match(await space.textContent(), /B12/); assert.equal(await p.evaluate(() => window.__rendered.plate), '沪A12345');
    await p.evaluate(() => { window.__failReview = false; }); await button(p, '资料无误，通过').click();
    await p.waitForFunction(() => window.__rendered.status === 'approved' && window.__cart?.intakeId === 71);
    assert.equal(await p.evaluate(() => window.__cart.months), 6);
    assert.equal(await p.getByText('新办月租', { exact: false }).count() > 0, true);
    assert.equal(await p.getByLabel('本页收费清单').textContent(), '待收款 · 登记 71 · 6 个月 · 600 元');
    await button(p, '1 个月').click(); await p.waitForFunction(() => window.__cart?.months === 1);
    assert.equal(await p.getByLabel('本页收费清单').textContent(), '待收款 · 登记 71 · 1 个月 · 100 元');
    assert.equal(await p.evaluate(() => window.__cart.intakeId), 71);
    assert.equal(await p.evaluate(() => window.__calls.filter(c => c.url.endsWith('/staff-submit')).length), 1);
    assert.equal(await p.evaluate(() => window.__calls.filter(c => c.url.endsWith('/files')).length), 0);
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.url.includes('/business-contact'))), false);
    assert.equal(await p.evaluate(() => window.__current().ownerPhone), '13900000000');
    assert.equal(await p.evaluate(() => window.__current().contactPhone), '13711112222');
    assert.equal(new URL(p.url()).pathname, '/');
    await screenshot(p, `inline-renewal-${width}.png`);
  } finally { await f.close(); }
});

test('family choice keeps conversion safeguards and local submission needs no attachment', { timeout: 30000 }, async () => {
  const f = await fixture(375); const p = f.page;
  try {
    await p.getByRole('radio', { name: '亲情车', exact: true }).click();
    assert.equal(await button(p, '确认转换登记类型').isDisabled(), true);
    await p.getByLabel('转换后与业主关系', { exact: true }).fill('父母');
    p.once('dialog', d => d.accept()); await button(p, '确认转换登记类型').click();
    await p.waitForFunction(() => window.__rendered.kind === 'family');
    await button(p, '工作人员直接代填').click();
    const term = p.getByRole('group', { name: '车牌授权期限' });
    assert.equal(await term.getByRole('button',{name:'12 个月',exact:true}).getAttribute('aria-pressed'),'true');
    await term.screenshot({path:path.join(out,'family-term-375.png')});
    await term.getByRole('button',{name:'6 个月',exact:true}).click();
    await term.getByLabel('自定义续期月数').fill('5');
    await p.getByRole('button', { name: '点选车牌', exact: true }).click();
    for (const key of '沪A12345') await p.locator('.intake-plate-keys').getByRole('button', { name: key, exact: true }).click();
    await p.getByLabel('本车联系手机（必填）').fill('13711112222');
    assert.equal(await button(p, '保存登记，继续授权').isEnabled(), true);
    await button(p, '保存登记，继续授权').click(); await p.waitForFunction(() => window.__rendered.status === 'submitted');
    assert.deepEqual(await p.evaluate(() => window.__current().registrationTerm), {mode:'months',months:5});
    assert.equal(await p.evaluate(() => window.__current().files.length), 0);
    assert.equal(await p.evaluate(() => window.__current().relation), '父母');
    assert.equal(await p.evaluate(() => window.__current().ownerPhone), '13900000000');
    await screenshot(p, 'family-no-attachment-375.png');
  } finally { await f.close(); }
});

test('local click/drop/targeted paste uploads exactly once and QR stays available', { timeout: 60000 }, async () => {
  const f = await fixture(1440); const p = f.page;
  try {
    await button(p, '工作人员直接代填').click();
    await p.locator('input[type=file]').setInputFiles({ name: 'click.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
    await p.waitForFunction(() => window.__rendered.files.length === 1);
    await p.locator('.intake-upload').evaluate(el => { const dt = new DataTransfer(); dt.items.add(new File(['fixture'], 'drop.png', { type: 'image/png' })); el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); });
    await p.waitForFunction(() => window.__rendered.files.length === 2);
    await p.locator('.intake-upload').evaluate(el => { el.focus(); const dt = new DataTransfer(); dt.items.add(new File(['fixture'], 'paste.png', { type: 'image/png' })); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })); });
    await p.waitForFunction(() => window.__rendered.files.length === 3);
    assert.equal(await p.evaluate(() => window.__calls.filter(c => c.url.endsWith('/files')).length), 3);
    assert.equal(await button(p, '放大扫码登记二维码').count(), 1);
    await screenshot(p, 'staff-local-upload-1440.png');
  } finally { await f.close(); }
});
