const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../../..');
const dir = path.join(root, 'apps/miniapp-staff/miniprogram/pages/material-inbound');
const out = path.join(root, 'outputs/material-inbound-actions-20261116');
const template = fs.readFileSync(path.join(dir, 'material-inbound.wxml'), 'utf8').match(/<view wx:if="\{\{!loading && canEdit\}\}" class="action-bar">[\s\S]*?(?=\n<view wx:if="\{\{warehousePickerOpen)/)[0];
const rpx = value => value.replace(/(-?[\d.]+)rpx/g, (_, n) => `calc(${n} * 100vw / 750)`);
const css = rpx(['packages/miniapp-ui/tokens.wxss', 'apps/miniapp-staff/miniprogram/app.wxss', path.relative(root, path.join(dir, 'material-inbound.wxss'))].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n').replace(/@import[^;]+;/g, '').replace(/\bpage\s*\{/g, 'body {'));
async function render(page, patch = {}) {
  const data = { loading: false, canEdit: true, source: 'general', mode: 'inbound', saving: false, uploading: false, justCreated: false, poOrder: null, poLoading: false, poRows: [], ...patch };
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#edf3f8}view{display:block}block{display:contents}button{border:0}button[loading=true]::before{content:'';width:20px;height:20px;flex-shrink:0;margin-right:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%}${css}</style><main></main>`);
  await page.evaluate(({ template, data }) => {
    const tpl = document.createElement('template'); tpl.innerHTML = template;
    const evaluate = expression => Function(...Object.keys(data), `return (${expression});`)(...Object.values(data));
    const interpolate = value => value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression) ?? ''));
    window.taps = [];
    function children(src, target) {
      let taken = false;
      for (const node of src.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { target.append(document.createTextNode(interpolate(node.textContent))); continue; }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const condition = name => node.getAttribute(name)?.replace(/^\{\{|\}\}$/g, '');
        if (node.hasAttribute('wx:if')) { taken = !!evaluate(condition('wx:if')); if (!taken) continue; }
        else if (node.hasAttribute('wx:elif')) { if (taken) continue; taken = !!evaluate(condition('wx:elif')); if (!taken) continue; }
        else if (node.hasAttribute('wx:else')) { if (taken) continue; taken = true; }
        else taken = false;
        const el = document.createElement(node.tagName);
        for (const attr of node.attributes) {
          if (/^(wx:|bind)/.test(attr.name)) continue;
          if (attr.name === 'disabled') { el.disabled = !!evaluate(condition('disabled')); continue; }
          el.setAttribute(attr.name, interpolate(attr.value));
        }
        const method = node.getAttribute('bindtap'); if (method) el.onclick = () => window.taps.push(method);
        children(node, el); target.append(el);
      }
    }
    children(tpl.content, document.querySelector('main'));
  }, { template, data });
}

test('实际入库底栏模板/样式：用满可用宽度、单行等高、加载与禁用不跳动', async t => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    for (const width of [320, 375, 430]) await t.test(`${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 812 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      for (const mode of ['inbound', 'create']) {
        await render(page, { mode });
        const geometry = async () => page.locator('.action-bar').evaluate(bar => {
          const row = bar.querySelector('.btn-row'), b = bar.getBoundingClientRect(), r = row.getBoundingClientRect(), style = getComputedStyle(bar);
          return { gap: b.right - parseFloat(style.paddingRight) - r.right, width: r.width, buttons: [...bar.querySelectorAll('button')].map(el => {
            const rect = el.getBoundingClientRect(), label = el.querySelector('text') || el;
            const range = document.createRange(); range.selectNodeContents(label);
            const lines = [...new Set([...range.getClientRects()].map(r => Math.round(r.top)))].length;
            return { width: rect.width, height: rect.height, top: rect.top, right: rect.right, lines };
          }), scrollWidth: document.documentElement.scrollWidth };
        });
        const initial = await geometry();
        assert.ok(initial.gap < 2, `unused right side: ${initial.gap}px`);
        assert.equal(initial.buttons.length, 2);
        assert.ok(initial.buttons.every(b => b.lines === 1), JSON.stringify(initial));
        assert.ok(Math.abs(initial.buttons[0].height - initial.buttons[1].height) < 1);
        assert.ok(initial.buttons.every(b => b.height >= 88 * width / 750));
        assert.ok(initial.scrollWidth <= width);
        await page.screenshot({ path: path.join(out, `${mode}-${width}.png`) });
        await page.locator('.btn--primary').click();
        assert.deepEqual(await page.evaluate(() => window.taps), [mode === 'inbound' ? 'onSubmitInbound' : 'onSaveCreate']);
        for (const state of [{ saving: true }, { uploading: true }]) {
          await render(page, { mode, ...state }); const pending = await geometry();
          assert.ok(pending.buttons.every((b, i) => Math.abs(b.height - initial.buttons[i].height) < 1 && Math.abs(b.width - initial.buttons[i].width) < 1), JSON.stringify({ mode, state, initial, pending }));
          assert.ok(pending.buttons.every(b => b.lines === 1));
          assert.equal(await page.locator('.btn--primary').isDisabled(), true);
        }
      }
      await render(page, { justCreated: true }); assert.equal(await page.locator('.btn--ghost').innerText(), '暂不入库');
      await render(page, { mode: 'search' }); assert.equal(await page.locator('button').count(), 1);
      await render(page, { source: 'po', poOrder: {}, poRows: [{}, {}] }); assert.match(await page.locator('button').innerText(), /确认入库 2 项/);
      await render(page, { loading: true }); assert.equal(await page.locator('button').count(), 0);
      await render(page, { canEdit: false }); assert.equal(await page.locator('button').count(), 0);
      assert.deepEqual(errors, []); await page.close();
    });
  } finally { await browser.close(); }
});

test('原有提交方法：数量单价来源及库位请求不变，错误保留表单、成功显示回执', async () => {
  const ts = createRequire(path.join(root, 'apps/api/package.json'))('typescript');
  let definition, request, fail = true;
  const messages = [];
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(dir, 'material-inbound.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: value => { definition = value; }, requirePlugin: () => { throw Error('not installed in fixture'); },
    require: name => name === '@pms/shared-types' ? { MATERIAL_UNITS: ['个'] } : name.endsWith('/guide') ? { guideHandlers: () => ({}) } : name === '@pms/api-client' ? { inventory: { createGeneralReceipt: async body => { request = body; if (fail) throw Error('测试失败'); return { receiptNo: 'TEST-1' }; } } } : {},
    wx: { navigateBack: () => {}, showToast: m => messages.push(m), showModal: m => { messages.push(m); m.success?.({ confirm: true }); } }, console,
  });
  const ctx = { ...definition, data: { ...JSON.parse(JSON.stringify(definition.data)), selected: { materialId: 11, title: '测试材料', unit: '个' }, warehouses: [{ id: 1, name: '测试仓', enabled: true }], warehouseIndex: 0, selectedWarehouseId: 1, selectedWarehouseName: '测试仓', locationIndex: 1, locations: [{ id: 5, label: 'A格' }], inboundForm: { qty: '4', priceYuan: '8.8', sourceText: '旧件拆机' } }, setData(patch) { Object.assign(this.data, patch); } };
  await ctx.onSubmitInbound();
  assert.equal(JSON.stringify(request), JSON.stringify({ warehouseId: 1, sourceText: '旧件拆机', items: [{ materialId: 11, qty: 4, unitCostCents: 880, locationId: 5 }] }));
  assert.equal(ctx.data.saving, false); assert.equal(ctx.data.inboundForm.qty, '4'); assert.equal(messages.at(-1).title, '测试失败');
  fail = false; await ctx.onSubmitInbound(); assert.equal(messages.at(-1).title, '入库完成'); assert.match(messages.at(-1).content, /TEST-1/); assert.equal(ctx.data.saving, false);
});
