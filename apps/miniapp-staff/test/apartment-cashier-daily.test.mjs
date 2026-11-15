import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const ts = requireApi('typescript');
const dir = new URL('../miniprogram/pages/apartment-cashier/', import.meta.url);
const source = readFileSync(new URL('apartment-cashier.ts', dir), 'utf8');
const wxml = readFileSync(new URL('apartment-cashier.wxml', dir), 'utf8');
const shared = {};
for (const path of ['fees.ts', 'beijing-time.ts']) {
  const url = new URL('../../../packages/shared-types/src/' + path, import.meta.url);
  vm.runInNewContext(ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: shared });
}
function fixture(api = {}) {
  let page;
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports: {}, Page: p => { page = p; }, require: name => name === '@pms/api-client' ? { apartmentCashier: api } : name === '@pms/shared-types' ? shared : name.includes('guide') ? { guideHandlers: () => ({}) } : {},
    wx: { showToast() {}, stopPullDownRefresh() {} },
  });
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => Object.assign(page.data, patch);
  return page;
}
const row = (receiptNo, houseId = 1) => ({ receiptNo, houseId, communityName: '春风公寓', buildingNo: '13', roomNo: '101', paidAt: '2026-11-14T16:10:00Z', paymentMethod: 'cash', amountCents: 2000, status: 'paid', items: [{ feeName: '电费', quantity: 12.5, unit: '度' }, { feeName: '房租', quantity: null, unit: '月' }] });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
test('今日汇总用服务端全部页净额，保留红冲负数，显示完整地址与数量', async () => {
  const calls = [];
  const p = fixture({ today: async page => { calls.push(page); return { rows: [{ ...row('A'), amountCents: -2000, status: 'refunded' }], total: 25, totalCents: 123456 }; } });
  await p.loadToday();
  assert.deepEqual(calls, [1]);
  assert.equal(p.data.todayTotal, 25);
  assert.equal(p.data.todayAmountText, shared.formatFeeMoney(123456));
  assert.match(p.data.todayRows[0].itemsText, /电费 ×12.5度/);
  assert.doesNotMatch(p.data.todayRows[0].itemsText, /房租 ×0/);
  assert.match(p.data.todayRows[0].placeText, /春风公寓.*13号-101室/);
  assert.match(p.data.todayRows[0].timeText, /00:10/);
  assert.match(p.data.todayRows[0].amountText, /^-/);
  assert.equal(p.data.todayRows[0].refunded, false); assert.equal(p.data.todayRows[0].statusText, '红冲退款');
});
test('今日分页同收据号跨户不丢；重读旧响应不能覆盖新汇总', async () => {
  const first = deferred(); let n = 0;
  const p = fixture({ today: async page => { n++; if (n === 1) return first.promise; return { rows: [row('SAME', page)], total: 2, totalCents: 4000 }; } });
  const old = p.loadToday(); await p.loadToday();
  first.resolve({ rows: [row('OLD')], total: 99, totalCents: 99 }); await old;
  assert.equal(p.data.todayTotal, 2); assert.equal(p.data.todayRows[0].receiptNo, 'SAME');
  await p.onMoreToday(); assert.equal(p.data.todayRows.length, 2); assert.notEqual(p.data.todayRows[0].key, p.data.todayRows[1].key);
});
test('今日失败显示错误而非零收入，可重试且不清收费草稿', async () => {
  let fail = true;
  const p = fixture({ today: async () => { if(fail) throw Error('无权查看'); return { rows: [], total: 0, totalCents: 0 }; } });
  p.data.rows = [{ feeCode: 'rent', amountCents: 2000 }];
  await p.loadToday(); assert.match(p.data.todayError, /无权查看/); assert.equal(p.data.todayLoaded, false);
  fail = false; await p.loadToday(); assert.equal(p.data.todayLoaded, true); assert.equal(p.data.todayError, ''); assert.equal(p.data.rows.length, 1);
});
test('本户历史显示项目数量；换房乱序不能显示前户数据；失败不假装没有记录', async () => {
  const a = deferred();
  const p = fixture({ history: async id => id === 1 ? a.promise : { rows: [row('B', 2)], total: 1 } });
  const old = p.loadHistory(1); await p.loadHistory(2); a.resolve({ rows: [row('A')], total: 1 }); await old;
  assert.equal(p.data.history[0].receiptNo, 'B'); assert.match(p.data.history[0].itemsText, /×12.5度/);
  const failed = fixture({ history: async () => { throw Error('历史接口失败'); } }); await failed.loadHistory(1); assert.match(failed.data.historyError, /历史接口失败/);
});
test('自定义收款方式不丢，缺失数量不捏造成零，明确零数量保留', async () => {
  const p = fixture({ history: async () => ({ rows: [{ ...row('C'), paymentMethod: '新渠道', status: 'refunded', items: [{ feeName: '水费', quantity: 0, unit: '吨' }, { feeName: '房租' }] }], total: 1 }) });
  await p.loadHistory(1);
  assert.equal(p.data.history[0].methodText, '新渠道'); assert.match(p.data.history[0].itemsText, /水费 ×0吨/);
  assert.match(p.data.history[0].itemsText, /房租（数量未记录）/); assert.equal(p.data.history[0].refunded, true);
});
test('翻页期间新增流水自动重读第一页，防重复记录与错误进度', async () => {
  const calls = [];
  const p = fixture({ today: async page => { calls.push(page); return { rows: [row(page === 1 ? 'NEW' : 'A')], total: calls.length === 1 ? 2 : 3, totalCents: 6000 }; } });
  await p.loadToday(); await p.onMoreToday();
  assert.deepEqual(calls, [1, 2, 1]); assert.equal(p.data.todayPage, 1); assert.equal(p.data.todayRows.length, 1); assert.equal(p.data.todayTotal, 3);
});
test('历史总数变动重读，同户重复收据去重，空收款方式明确标注', async () => {
  const calls = [];
  const p = fixture({ history: async (id, page) => { calls.push(page); return { rows: [{ ...row('A'), paymentMethod: '' }, row('A')], total: calls.length === 1 ? 2 : 3 }; } });
  p.data.houses = [{ id: 1 }]; p.data.houseIndex = 0;
  await p.loadHistory(1); await p.onMoreHistory();
  assert.deepEqual(calls, [1,2,1]); assert.equal(p.data.history.length, 1); assert.equal(p.data.historyPage, 1);
  assert.equal(p.data.history[0].methodText, '收款方式未记录');
});
test('跨北京日期查看更多时清旧日并读新日第一页，无权限不请求', async () => {
  const calls = [];
  const p = fixture({ today: async page => { calls.push(page); return { rows: [], total: 0, totalCents: 0 }; } });
  Object.assign(p.data, { todayDate: '2000-01-01', todayLoaded: true, todayRows: [row('OLD')], todayPage: 1, todayTotal: 20 });
  await p.onMoreToday(); assert.deepEqual(calls, [1]); assert.equal(p.data.todayRows.length, 0); assert.notEqual(p.data.todayDate, '2000-01-01');
  p.data.canSeeCashier = false; await p.loadToday(); assert.deepEqual(calls, [1]);
});
test('历史分页、分页失败保留已读内容，切房后旧请求失效', async () => {
  let fail = false; const calls = [];
  const p = fixture({ history: async (id, page) => { calls.push(page); if(fail) throw Error('重试'); return { rows: [row(String(page))], total: 2 }; } });
  p.data.houses = [{ id: 1 }]; p.data.houseIndex = 0;
  await p.loadHistory(1); fail = true; await p.onMoreHistory();
  assert.equal(p.data.history.length, 1); assert.equal(p.data.historyPage, 1); assert.equal(p.data.historyTotal, 2);
  fail = false; await p.onMoreHistory(); assert.deepEqual(calls, [1,2,2]); assert.equal(p.data.history.length, 2);
  const pending = deferred(); const delayed = fixture({ history: async () => pending.promise });
  const request = delayed.loadHistory(1); Object.assign(delayed.data, delayed.clearedHouse());
  pending.resolve({ rows: [row('OLD')], total: 1 }); await request; assert.equal(delayed.data.history.length, 0); assert.equal(delayed.data.historyLoading, false);
});
test('历史不展示订单号，费用图示有独立颜色和文字，今日卡片位于选房块之外', () => {
  assert.match(wxml, /本户历史缴费记录/);
  const history = wxml.slice(wxml.indexOf('本户历史缴费记录'), wxml.indexOf('<!-- 今日收费'));
  assert.doesNotMatch(history, /\{\{item\.receiptNo\}\}/);
  assert.match(wxml, /fee-icon--\{\{item.code\}\}/);
  const styles = readFileSync(new URL('../miniprogram/pages/apartment-cashier/apartment-cashier.wxss', import.meta.url), 'utf8');
  assert.match(styles, /\.container\.container--with-bar\s*\{\s*padding-bottom: calc\(340rpx/);
  for (const code of shared.APARTMENT_FEE_TYPES.map(item => item.code)) assert.match(styles, new RegExp('\\.fee-icon--' + code + ' \\{ background-color: #[0-9a-f]{6}; background-image: url'));
  assert.match(wxml, /今日收费汇总/); assert.match(wxml, /今日收费明细/);
  assert.match(wxml, /todayError/); assert.match(wxml, /historyError/);
  assert.ok(wxml.indexOf('今日收费汇总') > wxml.indexOf('先选房间，再收费'));
});
