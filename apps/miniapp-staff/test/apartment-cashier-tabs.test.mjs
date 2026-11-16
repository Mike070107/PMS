import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ts = createRequire(new URL('../../api/package.json', import.meta.url))('typescript');
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const shared = {};
for (const name of ['fees', 'beijing-time', 'address']) vm.runInNewContext(ts.transpileModule(read(`../../../packages/shared-types/src/${name}.ts`), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: shared });
const source = read('../miniprogram/pages/apartment-cashier/apartment-cashier.ts');
const wxml = read('../miniprogram/pages/apartment-cashier/apartment-cashier.wxml');
const event = tab => ({ currentTarget: { dataset: { tab } } });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function fixture(api = {}) {
  let p; const calls = [];
  const cashier = {
    todaySummary: async () => { calls.push('summary'); return { total: 5, totalCents: 12000 }; },
    today: async page => { calls.push(`details:${page}`); return { rows: [], total: 5, totalCents: 12000 }; },
    history: async id => { calls.push(`history:${id}`); return { rows: [], total: 0 }; },
    standards: async () => ({ rateQuote: null, standards: [{ feeCode: 'rent', status: 'active', amountCents: 180000 }] }),
    updateContact: async (id, data) => { calls.push({ id, ...data }); return { owner: { id: 9, name: data.ownerName, phone: data.ownerPhone } }; },
    ...api,
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: x => p = x,
    require: name => name === '@pms/shared-types' ? shared : name === '@pms/api-client' ? { apartmentCashier: cashier } : name.includes('/guide') ? { guideHandlers: () => ({ syncGuide() {} }) } : name.includes('/tabbar') ? { syncTabBar() {} } : {},
    wx: { showToast() {}, stopPullDownRefresh() {} },
  });
  p.data = JSON.parse(JSON.stringify(p.data)); p.setData = patch => Object.assign(p.data, patch);
  Object.assign(p.data, { loading: false, canCharge: true, houses: [{ id: 42, buildingNo: '1', roomNo: '101', owner: { id: 9, name: '原姓名', phone: '13800138000' } }], houseIndex: 0, ownerName: '原姓名', ownerPhone: '13800138000', placeText: '1号-101室' });
  return { p, calls };
}
test('初始为收费Tab，不查询今日明细；进入今日只查汇总，展开才查明细', async () => {
  const { p, calls } = fixture(); assert.equal(p.data.activeTab, 'charge'); assert.equal(p.data.todayDetailsExpanded, false);
  p.onShow(); assert.deepEqual(calls, []);
  await p.onSwitchTab(event('today')); assert.deepEqual(calls, ['summary']); assert.equal(p.data.todayAmountText, shared.formatFeeMoney(12000));
  await p.onToggleTodayDetails(); assert.deepEqual(calls, ['summary', 'details:1']);
  await p.onToggleTodayDetails(); await p.onMoreToday(); assert.deepEqual(calls, ['summary', 'details:1']);
  await p.onRefreshToday(); assert.deepEqual(calls, ['summary', 'details:1', 'summary']);
});
test('切Tab保留收费草稿，历史只读所选房，回今日默认折叠', async () => {
  const { p, calls } = fixture(); p.data.rows = [{ feeCode: 'rent', amountCents: 180000 }];
  await p.onSwitchTab(event('history')); assert.deepEqual(calls, ['history:42']);
  await p.onSwitchTab(event('today')); await p.onToggleTodayDetails(); await p.onSwitchTab(event('charge')); await p.onSwitchTab(event('today'));
  assert.equal(p.data.todayDetailsExpanded, false); assert.equal(p.data.rows[0].amountCents, 180000);
  assert.deepEqual(calls, ['history:42', 'summary', 'details:1', 'summary']);
});
test('折叠/离开Tab使在途明细失效，关闭时不保留旧明细', async () => {
  const d = deferred(); const { p } = fixture({ today: () => d.promise }); await p.onSwitchTab(event('today'));
  const request = p.onToggleTodayDetails(); await p.onToggleTodayDetails();
  d.resolve({ rows: [{ receiptNo: 'OLD', houseId: 42, items: [] }], total: 1, totalCents: 99 }); await request;
  assert.equal(p.data.todayDetailsExpanded, false); assert.equal(p.data.todayRows.length, 0); assert.equal(p.data.todayAmountText, shared.formatFeeMoney(12000));
});
test('无收费权限不可保存联系方式，未改不写；姓名手机号一起保存并同步选房缓存', async () => {
  const { p, calls } = fixture(); await p.saveContact(); assert.deepEqual(calls, []);
  p.onInputOwnerName({ detail: { value: ' 新姓名 ' } }); p.onInputOwnerPhone({ detail: { value: '13900139000' } });
  await p.onBlurContact(); assert.deepEqual(calls, [{ id: 42, ownerId: 9, ownerName: '新姓名', ownerPhone: '13900139000' }]);
  assert.equal(p.data.houses[0].owner.name, '新姓名'); assert.equal(p.data.ownerName, '新姓名'); assert.equal(p.data.contactStatus, '已自动保存');
  p.data.canCharge = false; p.data.ownerName = '越权'; await p.saveContact(); assert.equal(calls.length, 1);
});
test('自动保存失败保留输入和错误，重试可恢复；不能切房丢失未保存信息', async () => {
  let fail = true; const { p } = fixture({ updateContact: async () => { if (fail) throw Error('保存失败'); return { owner: { id: 9, name: '新姓名', phone: '13800138000' } }; } });
  p.data.houses.push({ id: 43, buildingNo: '2', roomNo: '201' }); p.data.ownerName = '新姓名';
  await p.onBlurContact(); assert.match(p.data.contactError, /保存失败/); assert.equal(p.data.ownerName, '新姓名');
  await p.pickHouse(1); assert.equal(p.data.houseIndex, 0);
  fail = false; await p.saveContact(); assert.equal(p.data.contactError, ''); assert.equal(p.data.houses[0].owner.name, '新姓名');
});
test('保存连点串行且不重复；保存期间输入变动不被旧响应覆盖', async () => {
  const d = deferred(); const { p, calls } = fixture({ updateContact: async (id, data) => { calls.push({ id, ...data }); if (calls.length === 1) return d.promise; return { owner: { id: 9, name: data.ownerName, phone: data.ownerPhone } }; } });
  p.data.ownerName = '先改'; const first = p.saveContact(); const second = p.saveContact();
  p.data.ownerPhone = '13900139000'; d.resolve({ owner: { id: 9, name: '先改', phone: '13800138000' } }); await Promise.all([first, second]);
  assert.equal(calls.length, 2); assert.equal(p.data.ownerPhone, '13900139000'); assert.equal(p.data.houses[0].owner.phone, '13900139000');
});
test('只读标准单价拒绝伪造输入事件；数量和实收金额仍按标准价计算', async () => {
  const { p } = fixture(); await p.loadRates(42); p.onToggleFee({ currentTarget: { dataset: { code: 'rent' } } });
  const input = (field, value) => p.onRowInput({ currentTarget: { dataset: { code: 'rent', field } }, detail: { value } });
  input('unitPriceYuan', '0.01'); assert.equal(p.data.rows[0].unitPriceYuan, '1800.00');
  input('quantityText', '2'); assert.equal(p.data.rows[0].amountCents, 360000);
  input('amountYuan', '1700.50'); assert.equal(p.data.rows[0].amountCents, 170050); assert.equal(p.data.rows[0].unitPriceYuan, '1800.00');
});
test('统计失败不回退查询明细；离开Tab后迟到统计无效，重试可恢复', async () => {
  const d = deferred(); const { p, calls } = fixture({ todaySummary: () => d.promise });
  const loading = p.onSwitchTab(event('today')); await Promise.resolve();
  await p.onSwitchTab(event('charge')); d.resolve({ total: 1, totalCents: 99 }); await loading;
  assert.equal(p.data.todayLoaded, false); assert.equal(p.data.activeTab, 'charge');
  let fail = true; const f = fixture({ todaySummary: async () => { if (fail) throw Error('统计服务不可用'); return { total: 2, totalCents: 500 }; } });
  await f.p.onSwitchTab(event('today')); assert.match(f.p.data.todaySummaryError, /统计服务不可用/);
  assert.equal(f.p.data.todayLoaded, false); assert.equal(f.calls.length, 0);
  fail = false; await f.p.onRefreshToday(); assert.equal(f.p.data.todayLoaded, true); assert.equal(f.p.data.todayTotal, 2); assert.equal(f.calls.length, 0);
  assert.equal(calls.includes('details:1'), false);
});
test('八个费用及三个收款方式图示逐条与Web原始SVG路径一致', () => {
  const css = read('../miniprogram/pages/apartment-cashier/apartment-cashier.wxss');
  const web = read('../../neighbor-web/src/pages/ApartmentCashier.tsx');
  const payment = read('../../neighbor-web/src/components/PaymentMethodIcon.tsx');
  const ant = createRequire(createRequire(new URL('../../neighbor-web/package.json', import.meta.url)).resolve('@ant-design/icons'));
  const svg = selector => decodeURIComponent(css.match(new RegExp(`\\.${selector} \\{[^\\n]*?data:image/svg\\+xml,([^\"]+)`))[1]);
  const paths = node => [...(node.tag === 'path' ? [node.attrs.d] : []), ...(node.children || []).flatMap(paths)];
  for (const [code, icon] of Object.entries({ electricity: 'ThunderboltOutlined', network: 'MobileOutlined', parking: 'CarOutlined', rent: 'HomeOutlined', management: 'ApartmentOutlined', deposit: 'CreditCardOutlined' })) {
    assert.ok(web.includes(`${code}: { icon: <${icon}`), `Web mapping: ${code}`);
    for (const path of paths(ant(`@ant-design/icons-svg/lib/asn/${icon}.js`).default.icon)) assert.ok(svg(`fee-icon--${code}`).includes(`d=\"${path}\"`), code);
  }
  const water = web.match(/function WaterDropIcon\(\).*?d="([^"]+)"/)[1];
  for (const code of ['cold_water', 'hot_water']) assert.ok(svg(`fee-icon--${code}`).includes(water));
  const webCss = read('../../neighbor-web/src/styles/apartment-cashier.css');
  for (const code of ['electricity', 'cold_water', 'hot_water', 'network', 'parking', 'rent', 'management', 'deposit']) {
    const palette = webCss.match(new RegExp(`\\.${code.replaceAll('_', '-')}\\s+i\\s*\\{\\s*color:(#[0-9a-f]+);\\s*background:(#[0-9a-f]+)`));
    assert.ok(svg(`fee-icon--${code}`).includes(`fill="${palette[1]}"`), `${code} foreground`);
    assert.ok(css.includes(`.fee-icon--${code} { background-color: ${palette[2]};`), `${code} background`);
  }
  for (const type of ['wechat', 'alipay', 'cash']) assert.ok(svg(`payment-icon--${type}`).includes(payment.match(new RegExp(`${type}: '([^']+)'`))[1]));
});
test('模板隔离三个面板及底栏，单价无输入绑定，方式有图标且联系信息失焦保存', () => {
  for (const tab of ['charge', 'history', 'today']) assert.match(wxml, new RegExp(`wx:(?:if|elif)="\\{\\{activeTab === '${tab}'\\}\\}"`));
  assert.match(wxml, /activeTab === 'charge'[^"\n]*placeText[^"\n]*" class="action-bar"/);
  assert.match(wxml, /wx:if="\{\{todayDetailsExpanded\}\}"/);
  assert.doesNotMatch(wxml, /data-field="unitPriceYuan"/);
  assert.match(wxml, /payment-icon--\{\{item.value\}\}/); assert.match(wxml, /bindblur="onBlurContact"/);
});
