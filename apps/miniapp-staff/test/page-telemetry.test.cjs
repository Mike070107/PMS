const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const apiRequire = createRequire(path.resolve(__dirname, '../../api/package.json'));
const ts = apiRequire('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../../packages/miniapp-ui/src/pageTelemetry.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

/** 用 vm 隔离每个用例，加载真实的公共上报工具；只替换小程序全局 Page/定时器/时钟。 */
function fixture({ token = true, batchSize = 3, intervalMs = 1000, send } = {}) {
  let now = 1_700_000_000_000;
  const timers = new Map();
  let timerSeq = 0;
  const sent = [];
  const originalShowCalls = [];
  const pages = [];
  const initialPage = (options) => { pages.push(options); return options; };
  const sandbox = {
    exports: {},
    module: { exports: {} },
    Page: initialPage,
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    Date: class extends Date { static now() { return now; } },
    console,
  };
  vm.runInNewContext(compiled, sandbox);
  const api = sandbox.exports;
  api.installPageTelemetry({
    source: 'miniapp-staff',
    prefix: 'miniapp-staff',
    hasToken: () => token,
    batchSize,
    intervalMs,
    send: send || (async (views) => { sent.push(views); }),
  });
  return {
    api, sandbox, sent, timers, pages, originalShowCalls,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    advance: (ms) => { now += ms; },
    runTimers: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
    register: (route, onShow) => {
      const options = { route, onShow };
      sandbox.Page(options); // 走被替换后的全局 Page，得到包装后的 onShow
      return options;
    },
  };
}

test('路径归一：只保留页面名，不带参数，登录页不统计', () => {
  const f = fixture();
  assert.equal(f.api.normalizePageRoute('pages/pool/pool', 'miniapp-staff'), '/miniapp-staff/pool');
  assert.equal(f.api.normalizePageRoute('pages/order-detail/order-detail?orderId=45#top', 'miniapp-staff'), '/miniapp-staff/order-detail');
  assert.equal(f.api.normalizePageRoute('/pages/me/me', 'miniapp-owner'), '/miniapp-owner/me');
  assert.equal(f.api.normalizePageRoute('pages/stocktake/stocktake-count', 'miniapp-staff'), '/miniapp-staff/stocktake/stocktake-count');
  assert.equal(f.api.normalizePageRoute('pages/login/login', 'miniapp-staff'), null, '登录页不上报');
  assert.equal(f.api.normalizePageRoute('', 'miniapp-staff'), null);
});

test('页面 onShow 自动上报：保留原 onShow，满 20/3 条批量发送并带 source', async () => {
  const f = fixture({ batchSize: 3 });
  const first = f.register('pages/pool/pool', function onShow() { f.originalShowCalls.push('pool'); });
  const second = f.register('pages/me/me', function onShow() { f.originalShowCalls.push('me'); });
  const third = f.register('pages/my-orders/my-orders', function onShow() { f.originalShowCalls.push('orders'); });

  first.onShow.call({ route: 'pages/pool/pool' });
  assert.equal(f.api.pendingPageViewCount(), 1);
  second.onShow.call({ route: 'pages/me/me' });
  assert.equal(f.api.pendingPageViewCount(), 2);
  assert.equal(f.sent.length, 0, '未到批量阈值先攒着');
  third.onShow.call({ route: 'pages/my-orders/my-orders' });
  await f.settle();

  assert.deepEqual(f.originalShowCalls, ['pool', 'me', 'orders'], '页面原有 onShow 必须照常执行');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent[0])), [
    { path: '/miniapp-staff/pool', source: 'miniapp-staff' },
    { path: '/miniapp-staff/me', source: 'miniapp-staff' },
    { path: '/miniapp-staff/my-orders', source: 'miniapp-staff' },
  ]);
  assert.equal(f.api.pendingPageViewCount(), 0);
});

test('30 秒定时上报；切后台 flushPageTelemetry 立即发送', async () => {
  const f = fixture({ batchSize: 20, intervalMs: 30_000 });
  const page = f.register('pages/pool/pool', () => undefined);
  page.onShow.call({ route: 'pages/pool/pool' });
  assert.equal(f.api.pendingPageViewCount(), 1);
  const scheduled = [...f.timers.values()];
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 30_000, '未满 20 条时按 30 秒定时');
  f.runTimers();
  await f.settle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.api.pendingPageViewCount(), 0);

  page.onShow.call({ route: 'pages/pool/pool' });
  f.advance(2000);
  page.onShow.call({ route: 'pages/pool/pool' });
  f.advance(2000);
  page.onShow.call({ route: 'pages/pool/pool' });
  f.api.flushPageTelemetry();
  await f.settle();
  assert.equal(f.sent.length, 2, 'onHide/flush 时立即发送');
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent[1].map((item) => item.path))), ['/miniapp-staff/pool', '/miniapp-staff/pool']);
});

test('未登录不上报；同一路径 1 秒内重复 onShow 只记一次；发送失败静默丢弃', async () => {
  const anonymous = fixture({ token: false });
  const page = anonymous.register('pages/pool/pool', () => undefined);
  page.onShow.call({ route: 'pages/pool/pool' });
  anonymous.api.flushPageTelemetry();
  await anonymous.settle();
  assert.equal(anonymous.api.pendingPageViewCount(), 0);
  assert.equal(anonymous.sent.length, 0, '未登录直接丢弃');

  const f = fixture({ batchSize: 20 });
  const same = f.register('pages/me/me', () => undefined);
  same.onShow.call({ route: 'pages/me/me' });
  same.onShow.call({ route: 'pages/me/me' });
  assert.equal(f.api.pendingPageViewCount(), 1, '同路径 1 秒内去重');
  f.advance(1500);
  same.onShow.call({ route: 'pages/me/me' });
  assert.equal(f.api.pendingPageViewCount(), 2, '超过 1 秒算新的一次访问');

  const failed = fixture({ batchSize: 1, send: async () => { throw new Error('网络失败/401'); } });
  const failPage = failed.register('pages/pool/pool', () => undefined);
  failPage.onShow.call({ route: 'pages/pool/pool' });
  await failed.settle();
  assert.equal(failed.api.pendingPageViewCount(), 0, '失败不重试、不提示用户');
});
