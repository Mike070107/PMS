const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const evidenceDir = path.resolve(app, '../../../..', 'pms-access-status-evidence');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DOOR_MESSAGE = '当前小区控制器回执来自上次检查，可点「重新检查在线状态」刷新。';
const LABELS = {
  cardWrite: '写卡工作站未接入',
  legacy: '.80 捷顺库在线',
  access: '.88 门禁网关在线',
};

function buildFixture() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const build = esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'access-status-browser.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outfile: path.join(evidenceDir, 'fixture.js'),
    alias: {
      '@/lib/auth': path.join(__dirname, 'access-status-browser-auth.ts'),
      '@/lib/perm': path.join(__dirname, 'access-status-browser-auth.ts'),
      '@': path.join(app, 'src'),
      '@pms/api-client': path.join(__dirname, 'access-status-browser-api.ts'),
      '@pms/shared-types': path.join(app, '../../packages/shared-types/src/index.ts'),
    },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env.VITE_LEGACY_BASE': '""',
      'import.meta.env.BASE_URL': '"/"',
    },
  });
  for (const file of build.outputFiles) fs.writeFileSync(file.path, file.contents);
  fs.writeFileSync(
    path.join(evidenceDir, 'fixture.html'),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>',
  );
}

/** 起静态服务 + 无头 Chrome，把 CDP 辅助函数交给用例；结束后一律关闭。 */
async function withPage(run, query = '') {
  buildFixture();
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0].slice(1);
    if (!['fixture.html', 'fixture.css', 'fixture.js'].includes(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader('Content-Type', name.endsWith('js') ? 'text/javascript' : name.endsWith('css') ? 'text/css' : 'text/html;charset=utf-8');
    response.end(fs.readFileSync(path.join(evidenceDir, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture.html${query}`;
  const profile = path.join(evidenceDir, 'chrome-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', url], { stdio: 'ignore' });
  let socket;
  try {
    for (let attempt = 0; attempt < 150 && !fs.existsSync(path.join(profile, 'DevToolsActivePort')); attempt += 1) await pause(100);
    const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    let tabs;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (tabs.find((tab) => tab.url === url)) break;
      await pause(100);
    }
    const tab = tabs.find((item) => item.url === url);
    assert.ok(tab, 'Chrome 没有打开合成夹具页面');
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

    let nextId = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(Error(method + ' 超时')), 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression, label, timeout = 8000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await js(expression)) return;
        await pause(80);
      }
      assert.fail('等待超时：' + label);
    };
    const dispatchClick = async (point) => {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await call('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point });
      }
      await pause(220);
    };
    const click = async (selector) => {
      const point = await js(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw Error('missing ' + ${JSON.stringify(selector)});
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await dispatchClick(point);
    };
    const clickText = async (selector, needle) => {
      const point = await js(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((item) => item.textContent.replace(/\\s/g, '').includes(${JSON.stringify(needle.replace(/\s/g, ''))}));
        if (!element) throw Error('missing ' + ${JSON.stringify(needle)});
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`);
      await dispatchClick(point);
    };
    const screenshot = async (name) => {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(shot.data, 'base64'));
    };
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await run({ js, call, click, clickText, waitFor, screenshot });
  } finally {
    socket?.close();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function pickHouse({ click, clickText, waitFor }) {
  await waitFor("!!document.querySelector('.findBar .ant-select-selector')", '房号选择器');
  await click('.findBar .ant-select-selector');
  await waitFor("!!document.querySelector('.ant-cascader-menu')", '地址下拉');
  await clickText('.ant-cascader-menu:nth-child(1) .ant-cascader-menu-item', '枫桦景苑一期');
  await waitFor("document.querySelectorAll('.ant-cascader-menu').length >= 2", '楼栋列');
  await clickText('.ant-cascader-menu:nth-child(2) .ant-cascader-menu-item', '6号楼');
  await waitFor("document.querySelectorAll('.ant-cascader-menu').length >= 3", '室号列');
  await clickText('.ant-cascader-menu:nth-child(3) .ant-cascader-menu-item', '502');
  await waitFor("document.body.textContent.includes('最近 30 笔做卡记录') && document.querySelectorAll('.ac-recent-row').length >= 1", '最近做卡区块');
}

test('readiness 三个在线 agent 但没有 issuer 时，顶部按能力分项显示且二期远程门禁不误报离线', { timeout: 120000 }, async () => {
  await withPage(async ({ js, click, clickText, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁页挂载');
    await waitFor("document.querySelectorAll('.ph .act .tag').length >= 3", 'readiness 能力标签');
    const tags = await js("[...document.querySelectorAll('.ph .act .tag')].map((item) => item.textContent.trim())");
    assert.ok(tags.includes(LABELS.cardWrite), '缺少写卡工作站未接入：' + JSON.stringify(tags));
    assert.ok(tags.includes(LABELS.legacy), '缺少 .80 捷顺库在线：' + JSON.stringify(tags));
    assert.ok(tags.includes(LABELS.access), '缺少 .88 门禁网关在线：' + JSON.stringify(tags));

    let bodyText = await js('document.body.textContent');
    assert.ok(!bodyText.includes('发卡工作站离线'), '有 agent 在线时不得显示发卡工作站离线');
    assert.ok(!bodyText.includes('发卡工作站在线'), '不再用一块「发卡工作站在线」概括整页');

    // 远程门禁默认小区必须来自 readiness.doorControlCommunities（二期），不是地址树第一个一期。
    await waitFor("document.querySelector('.door-panel select')?.value === '2'", '远程门禁默认二期小区');
    assert.equal(await js("document.querySelector('.door-panel select')?.selectedOptions?.[0]?.textContent"), '枫桦景苑二期');
    await waitFor("document.querySelector('.door-panel')?.textContent.includes('助手在线')", '远程门禁助手在线');
    const doorText = await js("document.querySelector('.door-panel').textContent");
    assert.ok(!doorText.includes('助手离线'), 'agentOnline:true 时不得显示助手离线');
    assert.ok(doorText.includes(DOOR_MESSAGE), 'data.message 应作为说明显示');
    assert.ok(!doorText.includes('远程开门已禁用'), '网关在线时不得禁用远程开门');
    const calls = await js('window.__calls');
    const doorCalls = calls.filter((item) => item.url === '/access-card-issuance/door/controllers');
    assert.equal(doorCalls.length > 0, true, '没有请求远程门禁控制器');
    assert.equal(Number(doorCalls[0].query?.communityId), 2, '远程门禁首次请求必须用二期小区 communityId=2');
    assert.ok(!doorCalls.some((item) => Number(item.query?.communityId) === 1), '不得再用一期小区请求控制器');
    bodyText = await js('document.body.textContent');
    assert.ok(!bodyText.includes('发卡工作站离线'), '整页不得出现发卡工作站离线');
    assert.ok(!bodyText.includes('助手离线'), '整页不得出现助手离线');
    await screenshot('access-status-normal.png');

    // 没有二期小区时：明确提示范围内没有二期联网门禁小区，且不渲染助手离线。
    const doorCallCount = calls.filter((item) => item.url === '/access-card-issuance/door/controllers').length;
    await js("document.getElementById('scenario-nodoor').click()");
    await waitFor("document.body.textContent.includes('当前范围内没有二期联网门禁小区')", '无二期小区提示');
    await pause(400);
    bodyText = await js('document.body.textContent');
    assert.ok(!bodyText.includes('助手离线'), '没有二期小区时不得显示助手离线');
    assert.ok(!bodyText.includes('发卡工作站离线'));
    const afterCalls = await js('window.__calls');
    assert.equal(
      afterCalls.filter((item) => item.url === '/access-card-issuance/door/controllers').length,
      doorCallCount,
      '没有二期小区时不应再请求控制器列表',
    );
    await screenshot('access-status-no-door-scope.png');
  });
});

test('最近 30 笔收发对象响应：pending 先显示旧行并轮询，ready 后渲染新行且能跳到该户历史', { timeout: 120000 }, async () => {
  await withPage(async ({ js, click, clickText, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁页挂载');
    // 通过真实 Cascader 选一户：一期 198 弄 6 号 502，选完后最近做卡区块才渲染。
    await pickHouse({ click, clickText, waitFor });
    // 选定房屋后，发卡说明应按 features.cardWrite 区分（写卡工作站未接入，不阻断查历史/写门禁库）。
    assert.ok((await js('document.body.textContent')).includes('写卡工作站未接入，新卡暂不能写到读卡器'), 'line 353 应按 cardWrite 区分提示');

    // 首次 pending：先显示旧行 + 助手回传中…，不能是「暂无最近做卡记录」。
    await waitFor("document.body.textContent.includes('助手回传中…')", 'pending 提示', 4000);
    let bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('OLD00001'), 'pending 时应先显示旧行');
    assert.ok(!bodyText.includes('暂无最近做卡记录'), 'pending 时不得显示暂无记录');
    await screenshot('access-status-recent-pending.png');

    // 1.5s 后轮询到 ready：渲染 2 行新记录，旧行被替换，显示更新于 hh:mm。
    await waitFor("document.querySelectorAll('.ac-recent-row').length === 2", 'ready 两行记录', 8000);
    bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('NEWA0001') && bodyText.includes('NEWA0002'), 'ready 后应渲染两行新记录');
    assert.ok(!bodyText.includes('OLD00001'), 'ready 后旧行应被替换');
    assert.ok(!bodyText.includes('暂无最近做卡记录'), 'ready 后不得显示暂无记录');
    assert.ok(/更新于 12:30/.test(bodyText), 'ready 应显示更新于 hh:mm');
    const recentCalls = (await js('window.__calls')).filter((item) => item.url === '/access-card-issuance/cards/recent');
    assert.ok(recentCalls.length >= 2, 'pending 后应自动轮询');
    assert.ok(recentCalls.every((item) => Number(item.query?.limit) === 30), '最近做卡必须 limit=30');
    const pollGap = recentCalls[1].at - recentCalls[0].at;
    assert.ok(pollGap >= 1400, 'pending 轮询间隔应约 1.5s，实际 ' + pollGap + 'ms');
    await screenshot('access-status-recent-ready.png');

    // 点「查看该户历史」应带上新行里的 communityId/lane/buildingNo/roomNo 跳到该户，而不是 toast 缺房号。
    await clickText('.ac-recent-row .btn', '查看该户历史');
    await waitFor(
      "window.__calls.some((item) => item.url === '/access-card-issuance/cards/history' && Number(item.query?.communityId) === 2 && item.query?.address === '228/3/502')",
      '跳转二期 228/3/502 户历史请求',
    );
    assert.ok(!(await js('document.body.textContent')).includes('缺少房屋信息'), '有完整房号字段时不应提示缺房号');
  });
});

test('最近 30 笔一直 pending：自动重试 5 次后出现可点的重试入口，不会卡死在助手回传中', { timeout: 120000 }, async () => {
  await withPage(async ({ js, click, clickText, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁页挂载');
    await pickHouse({ click, clickText, waitFor });

    // 用尽 5 次自动重试仍 pending：必须露出「重试」入口，并说明已暂停自动刷新。
    await waitFor("!!document.querySelector('.ac-recent-retry')", '自动重试耗尽后的重试入口', 15000);
    let bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('助手回传中'), '仍应显示助手回传中');
    assert.ok(bodyText.includes('助手回传较慢，已暂停自动刷新'), '应说明已暂停自动刷新');
    assert.ok(bodyText.includes('OLD00001'), 'pending 期间保留旧行');
    assert.ok(!bodyText.includes('暂无最近做卡记录'), 'pending 时不得显示暂无记录');
    const beforeCalls = (await js('window.__calls')).filter((item) => item.url === '/access-card-issuance/cards/recent');
    assert.equal(beforeCalls.length, 6, '首次 + 最多 5 次自动重试，实际 ' + beforeCalls.length);
    await screenshot('access-status-recent-stalled.png');

    // 重试入口可点：重新发起查询，按钮随新一轮轮询复位。
    await click('.ac-recent-retry');
    await waitFor(
      `window.__calls.filter((item) => item.url === '/access-card-issuance/cards/recent').length > ${beforeCalls.length}`,
      '点击重试后重新查询',
      4000,
    );
    await waitFor("!document.querySelector('.ac-recent-retry')", '重试后重试入口复位', 4000);
  }, '?recent-stall');
});
