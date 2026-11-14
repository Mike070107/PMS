// Actual ParkingSpaces, shared production CSS and main-only 3D; API/auth adapters are isolated fixtures.
// This is not evidence of production JWT/API/database/renewal/device behavior. The editor has its own suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const evidence = path.resolve(app, '../../outputs/parking-cards-20261112', process.env.PARKING_CAPTURE_BEFORE ? 'before' : 'after');

test('两库正式卡片：独立类别/完整字段、hover及focus清晰动效、减少动效/窄屏、人防无图及大车库真实3D', { timeout: 90000 }, async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const built = await esbuild.build({
    stdin: { loader: 'tsx', resolveDir: app, contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';
      import ParkingSpaces from '@/pages/ParkingSpaces';import {IconSprite} from '@/components/Icon';
      import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';
      function Fixture(){const [garage,setGarage]=useState(location.pathname.includes('civil')?'civil':'main');window.__setParkingGarage=setGarage;return <><IconSprite/><main className="pms-content"><ParkingSpaces garage={garage}/></main></>}
      createRoot(document.getElementById('root')).render(<BrowserRouter><Fixture/></BrowserRouter>);
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src') },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"' },
    plugins: [{ name: 'isolated-parking-adapters', setup(build) {
      build.onResolve({ filter: /^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        if (args.path.endsWith('/auth')) return { loader: 'js', contents: `const session={user:{id:1},access:{isTenantAdmin:true}};export const useSession=()=>session;export const auth={getAccess:()=>session.access,getToken:()=>null};` };
        if (args.path.endsWith('/perm')) return { loader: 'js', contents: `export const can=()=>true;` };
        return { loader: 'js', contents: `
          const make=(id,data)=>({id,garage:'main',spaceNo:String(id).padStart(3,'0'),houseNo:null,areaSqm:null,address:null,roomLabel:null,plate:null,ownerName:null,ownerTel:null,note:null,source:'fixture',endDate:null,category:null,...data});
          const main=[
            make(1,{category:'property',plate:'沪A12345',address:'228弄26号203室',ownerName:'测试业主甲与共同业主乙',ownerTel:'13800000001/021-12345678/13900000002',endDate:'2099-12-31'}),
            make(2,{category:'rental'}),
            make(3,{category:'vacant',plate:'沪AD12345',houseNo:'228/6/301',ownerName:'测试乙',ownerTel:'13800000003',endDate:'2099-12-31'}),
            make(4,{}),
            make(5,{plate:'沪B12345',note:'历史租赁资料待核实'}),
            make(6,{note:'产权车位'}),
            make(7,{plate:'沪C12345',note:'租赁车位'}),
            make(8,{note:'产权车位（待核实）'})
          ];
          window.__parkingCalls=[];window.__delayNextGarage=null;window.__delayFinished=true;window.__failNext=false;window.__emptyNext=false;
          export async function request(o){window.__parkingCalls.push(o);if(o.url!=='/business/parking-spaces'||(o.method&&o.method!=='GET'))throw Error('Unexpected fixture API '+JSON.stringify(o));
            if(window.__delayNextGarage===o.query.garage){window.__delayNextGarage=null;window.__delayFinished=false;await new Promise(r=>setTimeout(r,650));window.__delayFinished=true;}
            if(window.__failNext){window.__failNext=false;throw Error('隔离测试：车位暂时加载失败');}
            if(window.__emptyNext){window.__emptyNext=false;return {rows:[]};}
            const garage=o.query.garage;return {rows:main.map(row=>({...row,garage,id:row.id+(garage==='civil'?100:0)}))};
          }
          export const accessCardIssuance=new Proxy({}, {get:(_,name)=>()=>{throw Error('Unexpected business operation '+String(name));}});
          export const address={};
        ` };
      });
    } }],
  });
  const js = built.outputFiles.find(f => f.path.endsWith('.js')).contents;
  const css = built.outputFiles.find(f => f.path.endsWith('.css'))?.contents || '';
  const server = http.createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(js); }
    else if (req.url === '/fixture.css') { res.setHeader('content-type', 'text/css; charset=utf-8'); res.end(css); }
    else { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0}@media(min-width:901px){body{padding-left:236px}}.pms-content{max-width:1600px;margin:0 auto;padding:26px 28px 44px}@media(max-width:900px){.pms-content{padding:18px 14px 34px}}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [];
  const measurements = [];
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const cards = page.locator('.sp-card');
    const card = n => page.getByRole('article', { name: `车位 ${String(n).padStart(3, '0')}`, exact: true });
    // Both garages have eight fixture rows: wait for the requested region too, not stale rows before React commits.
    const waitCards = garage => page.waitForFunction(garage => document.querySelectorAll('.sp-card').length === 8 && (!garage || document.querySelector('.parking-spaces')?.getAttribute('aria-label') === (garage === 'main' ? '二期大车库' : '二期人防车库')), garage);
    const noOverflow = async label => {
      const m = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, clippedFields: [...document.querySelectorAll('.sp-kv dd')].filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).length }));
      measurements.push({ label, ...m }); assert.ok(m.scroll <= m.viewport + 1, label + ' no page overflow'); const missingTitles = await page.locator('.sp-kv dd').evaluateAll(els => els.filter(el => el.scrollWidth > el.clientWidth + 1 && el.title !== el.textContent.trim()).length); assert.equal(missingTitles, 0, label + ' clipped fields preserve complete accessible titles');
    };
    const completeFields = async () => {
      assert.equal(await page.locator('.sp-note').count(), 8, '所有车位均保留备注区，空值显示—');
      assert.equal(await card(2).locator('.sp-note').innerText(), '备注\n—');
      for (let i = 1; i <= 8; i++) assert.deepEqual(await card(i).locator('dt').allTextContents(), ['有效期', '房号', '业主', '电话']);
      assert.deepEqual(await card(2).locator('dd').allTextContents(), ['—', '—', '—', '—']);
      assert.deepEqual(await card(3).locator('dd').allTextContents(), ['2099-12-31', '228/6/301', '测试乙', '13800000003']);
      assert.equal(await card(1).locator('dd').nth(1).innerText(), '228/26/203');
      assert.equal(await card(1).locator('dd').nth(3).innerText(), '13800000001/021-12345678/13900000002');
      assert.equal(await card(2).locator('.sp-category').innerText(), '租赁'); assert.equal(await card(2).locator('.sp-empty').innerText(), '未绑车牌');
      assert.equal(await card(3).locator('.sp-category').innerText(), '空'); assert.equal(await card(3).getAttribute('data-state'), 'bound');
      assert.equal(await card(4).locator('.sp-category').innerText(), '产权'); assert.equal(await card(5).locator('.sp-category').innerText(), '产权');
      assert.equal(await card(6).locator('.sp-category').innerText(), '产权');
      assert.equal(await card(8).locator('.sp-category').innerText(), '产权');
    };
    await page.goto(origin + '/main'); await waitCards(); await completeFields(); await noOverflow('main1920');
    // Match the production 236px desktop rail and content cap, not a full-width standalone page.
    // Capture every baseline before enforcing density, so a red run still leaves comparable evidence.
    const density = [];
    for (const garage of ['main', 'civil']) {
      await page.evaluate(garage => window.__setParkingGarage(garage), garage); await waitCards(garage);
      for (const width of [1920, 1440, 1280, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width > 900 ? 1080 : 844 });
        await completeFields(); await noOverflow(`${garage}-${width}-compact`);
        const m = await page.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { width: r.width, height: r.height }; };
          return { columns: getComputedStyle(document.querySelector('.sp-grid')).gridTemplateColumns.split(' ').length,
            free: rect('[aria-label="车位 002"]'), normal: rect('[aria-label="车位 003"]'), long: rect('[aria-label="车位 001"]'), phone: rect('[aria-label="车位 003"] dd:last-of-type'),
            edit: rect('[aria-label="车位 003"] button'), metadataColumns: getComputedStyle(document.querySelector('.sp-kv')).gridTemplateColumns.split(' ').length };
        });
        density.push({ garage, viewport: width, ...m });
        await page.screenshot({ path: path.join(evidence, `${garage}-compact-${width}.png`), fullPage: true, animations: 'disabled' });
        if (width === 390) await card(3).screenshot({ path: path.join(evidence, `${garage}-normal-card-390.png`), animations: 'disabled' });
      }
    }
    fs.writeFileSync(path.join(evidence, 'density.json'), JSON.stringify(density, null, 2));
    for (const m of density) {
      assert.equal(m.free.height, m.normal.height, '普通/未绑车位等高'); assert.equal(m.free.height, 328, '两库所有卡片使用统一高度');
      assert.equal(m.long.height, m.normal.height, '长资料不能撑高单张卡片');
      assert.equal(m.metadataColumns, 2, '四个资料字段分别一行，尽量保留完整内容');
      assert.ok(m.phone.height <= 26, '普通手机号不单独折行：' + JSON.stringify(m));
      assert.ok(m.edit.width >= 44 && m.edit.height >= 44, '编辑操作仍有44px触控目标');
      if (m.viewport === 1920) assert.equal(m.columns, 4, '卡片适当放大，标准桌面内容区一行四个车位');
      if (m.viewport <= 390) assert.equal(m.columns, 1, '手机保留单列可读卡片');
    }
    await page.evaluate(() => window.__setParkingGarage('main')); await waitCards('main'); await page.setViewportSize({ width: 1920, height: 1080 });
    assert.ok(await card(1).locator('.icon').evaluate(el => el.getBBox().width > 0), 'production IconSprite renders actual vehicle glyph');
    assert.equal(await page.getByRole('button', { name: '车位图', exact: true }).count(), 1);
    await page.screenshot({ path: path.join(evidence, 'main-1920.png'), fullPage: true });
    for (const [category, count] of [['property', 5], ['rental', 2], ['vacant', 1]]) {
      await page.getByLabel('车位类别', { exact: true }).selectOption(category);
      await page.waitForFunction(n => document.querySelectorAll('.sp-card').length === n, count);
    }
    await page.getByLabel('车位类别', { exact: true }).selectOption('all'); await waitCards();
    await page.getByRole('button', { name: '未绑车牌', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.sp-card').length === 4);
    assert.equal(await card(2).locator('.sp-category').innerText(), '租赁');
    await page.getByRole('button', { name: '全部', exact: true }).click(); await waitCards();
    await page.getByRole('textbox', { name: '搜索车位' }).fill('021-12345678');
    await page.waitForFunction(() => document.querySelectorAll('.sp-card').length === 1);
    await page.getByRole('textbox', { name: '搜索车位' }).fill(''); await waitCards();

    const before = await card(1).evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }));
    await card(1).hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sp-card')).transform === 'matrix(1, 0, 0, 1, 0, -4)');
    const hover = await card(1).evaluate(el => ({ transform: getComputedStyle(el).transform, filter: getComputedStyle(el).filter, backdrop: getComputedStyle(el).backdropFilter, layerHint: getComputedStyle(el).willChange, shadow: getComputedStyle(el).boxShadow, height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }));
    assert.equal(hover.height, before.height); assert.equal(hover.width, before.width); assert.notEqual(hover.shadow, before.shadow);
    assert.equal(hover.filter, 'none'); assert.equal(hover.backdrop, 'none'); assert.equal(hover.layerHint, 'auto'); measurements.push({ label: 'hover', ...hover });
    await page.screenshot({ path: path.join(evidence, 'main-hover-1920.png'), fullPage: true });
    await page.mouse.move(1900, 0); await page.getByRole('button', { name: '车位图', exact: true }).focus(); await page.keyboard.press('Tab');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sp-card')).outlineStyle === 'solid');
    assert.equal(await card(1).getByRole('button').evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: path.join(evidence, 'main-focus-1920.png'), fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' }); await card(1).hover();
    assert.equal(await card(1).evaluate(el => getComputedStyle(el).transform), 'none');
    assert.equal(await card(1).evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.screenshot({ path: path.join(evidence, 'main-reduced-motion.png'), fullPage: true });
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.evaluate(() => document.activeElement?.blur());

    await page.getByRole('button', { name: '车位图', exact: true }).click();
    await page.getByRole('group', { name: /二期大车库车位 2.5D 示意图/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('.pgarage__canvas') && !document.querySelector('.pgarage__status'));
    assert.equal(await page.locator('.pgarage__status.is-error').count(), 0);
    assert.ok(await page.locator('.pgarage__canvas').evaluate(el => el.width > 0 && el.height > 0));
    await page.screenshot({ path: path.join(evidence, 'main-3d-1920.png'), fullPage: true });
    await page.evaluate(() => window.__setParkingGarage('civil')); await waitCards('civil');
    assert.equal(await page.locator('.pgarage').count(), 0); assert.equal(await page.getByRole('button', { name: '车位图', exact: true }).count(), 0);
    await completeFields(); await noOverflow('civil1920'); await page.screenshot({ path: path.join(evidence, 'civil-1920.png'), fullPage: true });
    assert.match(await page.getByRole('region', { name: '二期人防车库', exact: true }).innerText(), /进库必须先授权二期地面/);
    await page.evaluate(() => { window.__failNext = true; }); await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /隔离测试：车位暂时加载失败/);
    assert.equal(await page.getByText('没有符合条件的车位', { exact: true }).count(), 0, 'load error must not masquerade as an empty collection');
    assert.equal(await page.getByText('未取得车位数据', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(evidence, 'civil-error.png'), fullPage: true });
    await page.evaluate(() => { window.__delayNextGarage = 'civil'; }); await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByText('加载中…', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, 'civil-loading.png'), fullPage: true }); await waitCards();
    // A late main response cannot overwrite the new civil view.
    await page.evaluate(() => { window.__delayNextGarage = 'main'; window.__setParkingGarage('main'); });
    await page.waitForFunction(() => !window.__delayFinished); await page.evaluate(() => window.__setParkingGarage('civil')); await waitCards('civil');
    await page.waitForFunction(() => window.__delayFinished);
    assert.equal(await page.getByRole('button', { name: '车位图', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: '二期人防车库' }).count(), 1);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow('civil390'); await completeFields();
    await page.screenshot({ path: path.join(evidence, 'civil-390.png') });
    await card(1).screenshot({ path: path.join(evidence, 'civil-card-390.png') });
    await page.getByRole('button', { name: '表格', exact: true }).click(); await page.locator('table').waitFor(); await noOverflow('civil390-table');
    await page.getByRole('button', { name: '卡片', exact: true }).click(); await waitCards();
    // 两库都有8张同名车位卡；先确认旧DOM已卸载，不能把旧库数量当作新库加载完成。
    const previousCivilCard = await card(1).elementHandle();
    await page.evaluate(() => window.__setParkingGarage('main'));
    await page.waitForFunction(previous => !previous.isConnected, previousCivilCard);
    await waitCards('main'); await noOverflow('main390'); await completeFields();
    await page.screenshot({ path: path.join(evidence, 'main-390.png') }); await card(1).screenshot({ path: path.join(evidence, 'main-card-390.png') });
    await page.getByLabel('车位类别', { exact: true }).selectOption('property');
    await page.waitForFunction(() => document.querySelectorAll('.sp-card').length === 5); await noOverflow('main390-filter');
    await page.getByLabel('车位类别', { exact: true }).selectOption('all'); await waitCards();
    await page.getByRole('button', { name: '车位图', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pgarage__canvas') && !document.querySelector('.pgarage__status')); await noOverflow('main390-3d');
    await page.screenshot({ path: path.join(evidence, 'main-3d-390.png') });
    await page.getByRole('button', { name: '卡片', exact: true }).click(); await waitCards();
    for (const garage of ['main', 'civil']) {
      await page.evaluate(garage => window.__setParkingGarage(garage), garage); await waitCards(garage);
      await page.evaluate(() => { window.__emptyNext = true; }); await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText('没有符合条件的车位', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0); assert.equal(await page.getByText('0 个车位 · 已绑 0 · 未绑 0', { exact: true }).count(), 1);
      await page.screenshot({ path: path.join(evidence, garage + '-empty-390.png') });
      await page.evaluate(() => { window.__failNext = true; }); await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /隔离测试：车位暂时加载失败/);
      assert.equal(await page.getByText('没有符合条件的车位', { exact: true }).count(), 0, garage + ' failure is not empty data');
      assert.equal(await page.getByText('未取得车位数据', { exact: true }).count(), 1); assert.equal(await page.locator('.pgarage').count(), 0);
      await page.screenshot({ path: path.join(evidence, garage + '-error-390.png') });
      await page.getByRole('button', { name: '刷新', exact: true }).click(); await waitCards(); await completeFields(); await noOverflow(garage + '390-error-recovered');
      assert.equal(await page.getByRole('button', { name: '车位图', exact: true }).count(), garage === 'main' ? 1 : 0);
    }
    const calls = await page.evaluate(() => window.__parkingCalls);
    assert.equal(calls.filter(call => call.method && call.method !== 'GET').length, 0, 'layout/list interactions never write'); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify({ fixtureOnly: true, realPageAndCssAndMain3D: true, editorInteractionCoveredElsewhere: true, realJwtApiDatabaseOrDeviceVerified: false, measurements, apiReads: calls.length, businessWrites: 0, errors }, null, 2));
  } catch (error) {
    const failure = 'browser-failure-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(evidence, failure + '.json'), JSON.stringify({ message: error.message, stack: error.stack, errors }, null, 2));
    if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
      await page.screenshot({ path: path.join(evidence, failure + '.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(evidence, failure + '.html'), await page.content().catch(() => ''));
    }
    throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
