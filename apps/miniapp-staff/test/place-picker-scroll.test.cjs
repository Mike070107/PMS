const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = createRequire(path.resolve(__dirname, '../../api/package.json'))('typescript');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../../..');
const out = path.join(root, 'outputs/omission-release-20261117/place-picker');
const pick = index => ({ currentTarget: { dataset: { index } } });
function fixture(app = 'staff', count = 30) {
  let definition;
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const requireSource = name => {
      if (name === '@pms/api-client') return { address: {} }; // No transport calls in these interactions.
      const target = name === '@pms/shared-types' ? path.join(root, 'packages/shared-types/src/index.ts') : path.resolve(path.dirname(file), name + '.ts');
      return load(target);
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
      exports: module.exports, module, require: requireSource, Component: value => { definition = value; }, console,
    }, { filename: file });
    return module.exports;
  }
  const dir = path.join(root, `apps/miniapp-${app}/miniprogram/components/place-picker`);
  load(path.join(dir, 'index.ts'));
  const events = [];
  const ctx = { ...definition.methods, data: { ...Object.fromEntries(Object.entries(definition.properties).map(([key, prop]) => [key, prop.value])), ...JSON.parse(JSON.stringify(definition.data)) },
    setData(patch, done) { Object.assign(this.data, patch); done?.(); }, triggerEvent(name, detail) { events.push({ name, detail }); } };
  const book = [{ id: 1, name: '枫桦景苑二期', buildings: Array.from({ length: 25 }, (_, i) => ({ id: i + 10, buildingNo: String(i + 2), houses: [{ id: i + 100, roomNo: '201' }] })) }];
  const spots = Array.from({ length: count }, (_, i) => ({ id: i + 1, communityId: 1, buildingId: null, name: `公区点位${i + 1}`, enabled: true }));
  spots.push({ id: 99, communityId: 1, buildingId: 10, name: '2号楼电梯', enabled: true });
  ctx.setBook(book, spots); ctx.onOpen(); ctx.onPickRow(pick(0));
  return { ctx, events, dir };
}

// A DOM adapter renders the *actual* WXML / WXSS and executes the actual component methods.
// It proves layout and browser touch scrolling, not the native WeChat scroll-view implementation.
async function mount(page, f) {
  const wxml = fs.readFileSync(path.join(f.dir, 'index.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(f.dir, 'index.wxss'), 'utf8').replace(/(-?[\d.]+)rpx/g, (_, n) => `calc(${n} * 100vw / 750)`);
  await page.exposeFunction('invokePicker', ({ method, index, value }) => {
    if (method === 'onKeyword') f.ctx[method]({ detail: { value } });
    else f.ctx[method](pick(index));
    return JSON.parse(JSON.stringify(f.ctx.data));
  });
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>
    :root { --color-card-bg: #fff; --color-bg: #f4f6f9; --color-brand: #31558a; --color-border: #e3e7ec; --color-text-secondary: #666; --color-text-tertiary: #8c8c8c; --radius-sm: 8px; --radius-md: 10px; }
    body { margin:0; height:1600px; font-family:Arial,'Microsoft Yahei',sans-serif; background:#eee; }
    view, scroll-view, block { display:block; } block { display:contents; } scroll-view { overflow-y:auto; overflow-x:hidden; } input { border:0; } ${css}
    </style><main id="fixture"></main>`);
  await page.evaluate(({ wxml, data }) => {
    const tpl = document.createElement('template'); tpl.innerHTML = wxml;
    const evaluate = (expression, scope) => Function(...Object.keys(scope), `return (${expression});`)(...Object.values(scope));
    const interpolate = (value, scope) => value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression, scope) ?? ''));
    const render = data => {
      function node(src, scope, loop = false) {
        if (src.nodeType === Node.TEXT_NODE) return document.createTextNode(interpolate(src.textContent, scope));
        if (src.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
        const expr = name => src.getAttribute(name)?.replace(/^\{\{|\}\}$/g, '');
        if (!loop && src.hasAttribute('wx:for')) {
          const frag = document.createDocumentFragment();
          evaluate(expr('wx:for'), scope).forEach((item, index) => frag.append(node(src, { ...scope, item, index }, true)));
          return frag;
        }
        if (src.hasAttribute('wx:if') && !evaluate(expr('wx:if'), scope)) return document.createDocumentFragment();
        const el = document.createElement(src.tagName);
        for (const attr of src.attributes) {
          if (/^(wx:|catch|bind)/.test(attr.name)) continue;
          el.setAttribute(attr.name, interpolate(attr.value, scope).replace(/(-?[\d.]+)rpx/g, (_, n) => `calc(${n} * 100vw / 750)`));
        }
        for (const child of src.childNodes) el.append(node(child, scope));
        const method = src.getAttribute('catchtap') || src.getAttribute('bindtap');
        if (method) el.onclick = async event => { event.stopPropagation(); render(await window.invokePicker({ method, index: el.dataset.index })); };
        if (src.hasAttribute('bindinput')) el.oninput = async () => render(await window.invokePicker({ method: src.getAttribute('bindinput'), value: el.value }));
        return el;
      }
      const frag = document.createDocumentFragment(); for (const src of tpl.content.childNodes) frag.append(node(src, data));
      document.querySelector('#fixture').replaceChildren(frag);
    };
    render(data);
  }, { wxml, data: JSON.parse(JSON.stringify(f.ctx.data)) });
}

test('公区折叠状态不改变点位、整小区、楼栋及房号选择语义', () => {
  const { ctx, events } = fixture();
  assert.equal(typeof ctx.onToggleSpots, 'function');
  assert.equal(ctx.data.spotsExpanded, true);
  const count = ctx.data.spotRows.length;
  ctx.onToggleSpots(); assert.equal(ctx.data.spotsExpanded, false); assert.equal(ctx.data.spotRows.length, count);
  ctx.onToggleSpots(); ctx.onPickSpotRow(pick(20));
  assert.equal(events.at(-2).detail.spotName, '公区点位21'); assert.equal(events.at(-2).detail.isPublicArea, true);
  ctx.onOpen(); ctx.onPickRow(pick(0)); ctx.onStayHere();
  assert.equal(events.at(-2).detail.buildingId, null); assert.equal(events.at(-2).detail.isPublicArea, true);
  ctx.onOpen(); ctx.onPickRow(pick(0)); ctx.onPickRow(pick(0));
  assert.equal(ctx.data.level, 'house'); assert.equal(ctx.data.spotRows[0].name, '2号楼电梯');
  ctx.onPickRow(pick(0)); assert.equal(events.at(-2).detail.houseId, 100); assert.equal(events.at(-2).detail.isPublicArea, false);
  ctx.onOpen(); ctx.onPickRow(pick(0)); ctx.onPickRow(pick(0)); ctx.onSkipRoom();
  assert.equal(events.at(-2).detail.buildingId, 10); assert.equal(events.at(-2).detail.isPublicArea, false);
});

test('折叠后搜索、返回、关闭重开与空楼栋状态仍可正常选择', () => {
  const { ctx, events } = fixture();
  ctx.onToggleSpots(); ctx.onKeyword({ detail: { value: '公区点位9' } });
  assert.ok(ctx.data.suggestions.length > 0); ctx.onPickSuggestion(pick(0));
  assert.equal(events.at(-2).detail.spotName, '公区点位9');
  ctx.onOpen(); assert.equal(ctx.data.spotsExpanded, true);
  ctx.onPickRow(pick(0)); ctx.onPickRow(pick(0)); ctx.onBack();
  assert.equal(ctx.data.level, 'building'); assert.equal(ctx.data.rows.length, 25);
  ctx.onBack(); assert.equal(ctx.data.level, 'community'); assert.equal(ctx.data.spotRows.length, 0);
  ctx.onClose(); assert.equal(ctx.data.open, false);
  ctx.setBook([{ id: 9, name: '无楼栋小区', buildings: [] }], []);
  ctx.onOpen(); ctx.onPickRow(pick(0)); assert.equal(ctx.data.rows.length, 0);
  ctx.onStayHere(); assert.equal(events.at(-2).detail.communityId, 9);
});

test('真实WXML/WXSS：公区独立滚动、整体滚出视野、折叠腾空间和窄屏触摸', async t => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    for (const width of [375, 320]) await t.test(`${width}px`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 812 }, isMobile: true, hasTouch: true });
      const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
      const f = fixture(); await mount(page, f);
      assert.equal(await page.locator('.list .spot-section').count(), 1, '公区必须位于整体列表滚动区内，而非固定占位');
      assert.equal(await page.locator('.list .stay-here').count(), 1, '整小区公区入口也必须可滚出视野');
      const toggle = page.locator('.spot-section__toggle');
      await page.screenshot({ path: path.join(out, `expanded-${width}.png`) });
      const before = await page.locator('.list__item').first().boundingBox();
      await toggle.click(); await page.waitForFunction(() => !document.querySelector('.spot-list'));
      assert.equal(f.ctx.data.spotsExpanded, false);
      const collapsed = await page.locator('.list__item').first().boundingBox();
      assert.ok(before.y - collapsed.y > 100, '收起后楼栋列表应立即获得公区点位占用的空间');
      await page.screenshot({ path: path.join(out, `collapsed-${width}.png`) });
      await toggle.click(); await page.waitForSelector('.spot-list');
      const outerBefore = await page.locator('.list').evaluate(el => el.scrollTop);
      await page.locator('.spot-list').hover(); await page.mouse.wheel(0, 450);
      await page.waitForFunction(() => document.querySelector('.spot-list').scrollTop > 150);
      assert.equal(await page.locator('.list').evaluate(el => el.scrollTop), outerBefore, '公区内部滚动不应挪动外层楼栋');
      await page.locator('.spot-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.screenshot({ path: path.join(out, `spots-bottom-${width}.png`) });
      await page.locator('.list__item').first().hover(); await page.mouse.wheel(0, 420);
      await page.waitForFunction(() => document.querySelector('.list').scrollTop > 300);
      const geometry = await page.evaluate(() => {
        const area = document.querySelector('.list').getBoundingClientRect();
        const spot = document.querySelector('.spot-section').getBoundingClientRect();
        const stay = document.querySelector('.stay-here').getBoundingClientRect();
        return { areaTop: area.top, spotBottom: spot.bottom, stayBottom: stay.bottom,
          visibleRows: [...document.querySelectorAll('.list__item')].filter(el => { const r = el.getBoundingClientRect(); return r.top >= area.top && r.bottom <= area.bottom; }).length,
          overflow: document.documentElement.scrollWidth > innerWidth, backgroundScroll: window.scrollY };
      });
      assert.ok(geometry.spotBottom <= geometry.areaTop && geometry.stayBottom <= geometry.areaTop, JSON.stringify(geometry));
      assert.ok(geometry.visibleRows >= 5, JSON.stringify(geometry)); assert.equal(geometry.overflow, false); assert.equal(geometry.backgroundScroll, 0);
      await page.screenshot({ path: path.join(out, `buildings-scrolled-${width}.png`) });
      // Real browser touch input, not direct scrollTop mutation: swipe the building list upward.
      const cdp = await context.newCDPSession(page);
      const x = Math.floor(width / 2), y = 640;
      const prior = await page.locator('.list').evaluate(el => el.scrollTop);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let dy = 30; dy <= 240; dy += 30) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - dy }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(prior => document.querySelector('.list').scrollTop > prior + 30, prior);
      assert.deepEqual(errors, []); await context.close();
    });
  } finally { await browser.close(); }
});

test('业主端同类弹窗：整小区公区入口与房号跳过入口都属于整体滚动区', async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } }); const f = fixture('owner'); await mount(page, f);
    assert.equal(await page.locator('.list .stay-here').count(), 1);
    await page.locator('.list').hover(); await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('.list').scrollTop > 200);
  } finally { await browser.close(); }
});
