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
    // Chrome 刚写出 DevToolsActivePort 时文件可能仍被占用（EBUSY），重试到能读出端口为止。
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const parsed = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
        if (Number.isInteger(parsed) && parsed > 0) { port = parsed; break; }
      } catch { /* 文件还没写完/被锁，稍后重试 */ }
      await pause(100);
    }
    assert.ok(port > 0, 'Chrome 没有暴露 DevTools 端口');
    let tabs;
    for (let attempt = 0; attempt < 150; attempt += 1) {
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
    const waitFor = async (expression, label, timeout = 15000) => {
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

/** 通过真实 Cascader 选一户：一期 198 弄 6 号 502；选完后发卡历史才会渲染。 */
async function pickHouse({ click, clickText, waitFor }) {
  await waitFor("!!document.querySelector('.findBar .ant-select-selector')", '房号选择器');
  await click('.findBar .ant-select-selector');
  await waitFor("!!document.querySelector('.ant-cascader-menu')", '地址下拉');
  await clickText('.ant-cascader-menu:nth-child(1) .ant-cascader-menu-item', '枫桦景苑一期');
  await waitFor("document.querySelectorAll('.ant-cascader-menu').length >= 2", '楼栋列');
  await clickText('.ant-cascader-menu:nth-child(2) .ant-cascader-menu-item', '6号楼');
  await waitFor("document.querySelectorAll('.ant-cascader-menu').length >= 3", '室号列');
  await clickText('.ant-cascader-menu:nth-child(3) .ant-cascader-menu-item', '502');
  await waitFor("!!document.querySelector('[data-testid=history-block] .ac-history-table') && document.querySelectorAll('[data-testid=history-block] tbody tr[data-card-id]').length >= 1", '发卡历史');
}

test('门禁发卡页能力分项 + 设备管理独立页（控制器/在线/无二期小区不误报离线）', { timeout: 120000 }, async () => {
  await withPage(async ({ js, call, click, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁发卡页挂载');
    assert.equal(await js("document.querySelector('h1')?.textContent.trim()"), '门禁发卡');
    await waitFor("document.querySelectorAll('.ph .act .tag').length >= 3", 'readiness 能力标签');
    const tags = await js("[...document.querySelectorAll('.ph .act .tag')].map((item) => item.textContent.trim())");
    assert.ok(tags.includes(LABELS.cardWrite), '缺少写卡工作站未接入：' + JSON.stringify(tags));
    assert.ok(tags.includes(LABELS.legacy), '缺少 .80 捷顺库在线：' + JSON.stringify(tags));
    assert.ok(tags.includes(LABELS.access), '缺少 .88 门禁网关在线：' + JSON.stringify(tags));
    assert.equal(await js("!!document.querySelector('.door-panel')"), false, '门禁发卡页不再包含远程门禁/设备面板');
    await screenshot('access-cards-1280.png');

    // 设备管理独立页：默认二期小区、助手在线、控制器列表与开门按钮。
    await js("document.getElementById('show-devices').click()");
    await waitFor("!!document.querySelector('.door-panel')", '设备管理页挂载');
    assert.equal(await js("document.querySelector('h1')?.textContent.trim()"), '设备管理');
    await waitFor("document.querySelector('.door-panel select')?.value === '2'", '设备默认二期小区');
    assert.equal(await js("document.querySelector('.door-panel select')?.selectedOptions?.[0]?.textContent"), '枫桦景苑二期');
    await waitFor("document.querySelector('.door-panel')?.textContent.includes('助手在线')", '设备助手在线');
    const doorText = await js("document.querySelector('.door-panel').textContent");
    assert.ok(!doorText.includes('助手离线'), 'agentOnline:true 时不得显示助手离线');
    assert.ok(doorText.includes(DOOR_MESSAGE), 'data.message 应作为说明显示');
    i18n: {
      // 控制器列表与操作按钮来自设备管理
      assert.equal(await js("document.querySelectorAll('.door-table tbody tr').length"), 2);
      assert.ok(doorText.includes('6号大门') && doorText.includes('7号大门'));
      assert.ok(doorText.includes('立即开门') && doorText.includes('常开'));
    }
    const calls = await js('window.__calls');
    const doorCalls = calls.filter((item) => item.url === '/access-card-issuance/door/controllers');
    assert.ok(doorCalls.length > 0);
    assert.equal(Number(doorCalls[0].query?.communityId), 2, '设备管理首次请求必须用二期小区 communityId=2');
    await screenshot('access-devices-1280.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '设备管理 390 出现横向溢出');
    await screenshot('access-devices-390.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await pause(300);

    // 没有二期小区：明确提示，不渲染助手离线，也不再请求控制器列表。
    const doorCallCount = doorCalls.length;
    await js("document.getElementById('scenario-nodoor').click()");
    await waitFor("document.body.textContent.includes('当前范围内没有二期联网门禁小区')", '无二期小区提示');
    await pause(400);
    const bodyText = await js('document.body.textContent');
    assert.ok(!bodyText.includes('助手离线'), '没有二期小区时不得显示助手离线');
    assert.equal(
      (await js('window.__calls')).filter((item) => item.url === '/access-card-issuance/door/controllers').length,
      doorCallCount,
      '没有二期小区时不应再请求控制器列表',
    );
    await screenshot('access-devices-no-door-scope.png');
  });
});

test('最近 30 笔：进页即显示、10 条/页、添加到二期门禁系统无需确认、授权楼栋来自 grant-options', { timeout: 120000 }, async () => {
  await withPage(async ({ js, call, click, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁发卡页挂载');
    // 不选房也应显示最近 30 笔区块；默认折叠，展开后才加载 recent。
    assert.ok(await js("!!document.querySelector('[data-testid=recent-block]')"), '最近 30 笔不做选房前置');
    assert.equal(await js("window.__calls.filter((item) => item.url === '/access-card-issuance/cards/recent').length"), 0, '默认折叠不请求 recent');
    await js("document.querySelector('[data-testid=recent-toggle]').click()");
    await waitFor("!!document.querySelector('[data-testid=recent-block] tbody tr[data-card-id]') || document.body.textContent.includes('助手回传中…')", '展开后加载最近记录');
    await waitFor("document.body.textContent.includes('助手回传中…')", 'pending 提示', 5000);
    let bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('OLD00001'), 'pending 时应先显示旧行');
    assert.ok(!bodyText.includes('暂无最近做卡记录'), 'pending 时不得显示暂无记录');
    // 接口级 fieldsIncomplete=true（旧助手快照）：pending 旧行的空字段仍要提示升级。
    assert.ok(bodyText.includes('需升级现场助手（.80）'), '接口级 fieldsIncomplete=true 时旧行空字段应提示升级');
    assert.ok(
      (await js("document.querySelector('[data-testid=swipe-source-note]')?.textContent || ''")).includes('2021 年后二期门禁刷卡记录在 .88 系统，接入前显示 —。'),
      '页面应说明最后刷卡/出入口来源与 .88 未接入',
    );
    await screenshot('access-recent-pending.png');

    // ready 30 条：第 1 页 10 条、序号 1..10；分页到第 2/3 页。
    await waitFor("document.querySelectorAll('[data-testid=recent-block] tbody tr[data-card-id]').length === 10", 'ready 第 1 页 10 行', 9000);
    bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('NEWA0001') && bodyText.includes('NEWA0010'), '第 1 页应显示最新 10 条');
    assert.ok(!bodyText.includes('OLD00001'), 'ready 后旧行应被替换');
    assert.ok(!bodyText.includes('暂无最近做卡记录'));
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-testid=recent-block] tbody tr[data-card-id]')].map((row) => row.children[0].textContent.trim().replace(/[▸▾]/g, ''))"),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
      '最近记录第 1 页序号 1..10',
    );
    assert.ok((await js("document.querySelector('[data-testid=recent-pager]').textContent")).includes('共 30 条'));
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-testid=recent-block] thead th')].map((th) => th.textContent.trim())"),
      ['序号', '编号', '房号', '人事资料添加时间', 'IC卡号', 'WG卡号', '发卡时间', '最后刷卡时间', '出入口', '状态', '操作'],
      '最近记录 11 列与发卡历史一致',
    );
    // 空字段提示：只有 fieldsIncomplete 才提示升级；.80 无刷卡记录时显示 — 并带原因 title。
    const recentCells = async (id) => js(`[...document.querySelectorAll('[data-testid=recent-block] tbody tr[data-card-id="${id}"] td')].map((td) => ({ text: td.textContent.trim(), title: td.querySelector('[title]')?.getAttribute('title') || '', upgrade: !!td.querySelector('[data-upgrade-hint]') }))`);
    const swipeRow = await recentCells(1);
    assert.ok(swipeRow[7].text.includes('2026-11-01'), '有 lastSwipeAt 应显示最后刷卡时间：' + swipeRow[7].text);
    assert.equal(swipeRow[8].text, '228弄3号大门', '有 lastDevice 应显示出入口');
    const incompleteRow = await recentCells(2);
    assert.equal(incompleteRow[7].text, '需升级现场助手（.80）', '行级 fieldsIncomplete=true 仍应提示升级');
    assert.equal(incompleteRow[8].text, '需升级现场助手（.80）');
    assert.ok(incompleteRow[3].upgrade, '行级 fieldsIncomplete=true 时人事资料添加时间为空也应提示升级');
    const noRecordRow = await recentCells(3);
    assert.equal(noRecordRow[7].text, '—', 'fieldsIncomplete=false 且无刷卡记录应显示 —');
    assert.equal(noRecordRow[8].text, '—');
    assert.ok(noRecordRow[7].title.includes('2021 年后二期') && noRecordRow[8].title.includes('2021 年后二期'), '无记录 title 应说明 .88 未接入：' + JSON.stringify(noRecordRow[7]));
    assert.ok(!noRecordRow.some((cell) => cell.text.includes('需升级现场助手')), '字段已回传时无刷卡记录不得提示升级');
    await screenshot('access-recent-fields.png');
    await js("(() => { const buttons = [...document.querySelectorAll('[data-testid=recent-pager] button')]; buttons.find((b) => b.textContent.trim() === '2').click(); })()");
    await waitFor("document.querySelector('[data-testid=recent-block] tbody tr[data-card-id] td')?.textContent.trim().startsWith('11')", '最近记录第 2 页');
    assert.ok((await js('document.body.textContent')).includes('NEWA0011'));
    await screenshot('access-recent-page2.png');
    await js("(() => { const buttons = [...document.querySelectorAll('[data-testid=recent-pager] button')]; buttons.find((b) => b.textContent.trim() === '1').click(); })()");
    await waitFor("document.querySelector('[data-testid=recent-block] tbody tr[data-card-id] td')?.textContent.trim().startsWith('1')", '回到最近记录第 1 页');

    // 添加到二期门禁系统：无二次确认、直接 POST 正确 URL、成功按钮变绿不可点。
    const beforeApply = (await js('window.__calls')).filter((item) => item.method === 'POST').length;
    await js("document.querySelector('[data-card-id=\"2\"] .ac-apply-btn').click()");
    await waitFor("window.__calls.some((item) => item.method === 'POST' && item.url === '/access-card-issuance/cards/2/apply-mdb')", 'apply-mdb 请求');
    await waitFor("document.querySelector('[data-card-id=\"2\"]')?.textContent.includes('已添加二期门禁系统')", '成功行内绿色状态');
    assert.equal(await js("!!document.querySelector('.sheet')"), false, '添加到二期门禁系统不应弹二次确认');
    assert.equal((await js('window.__calls')).filter((item) => item.method === 'POST').length, beforeApply + 1);
    const applyCall = (await js('window.__calls')).find((item) => item.url === '/access-card-issuance/cards/2/apply-mdb');
    assert.deepEqual(applyCall.data.systems, ['iccard']);
    assert.equal(await js("document.querySelector('[data-card-id=\"2\"] [data-testid=apply-btn]').disabled"), true);
    await screenshot('access-recent-applied.png');

    // 授权楼栋：来自 grant-options，默认勾选本房楼栋 6。
    await click('[data-card-id="1"] .ac-grant-btn');
    await waitFor("!!document.querySelector('.sheet')", '授权楼栋抽屉');
    await waitFor("document.querySelectorAll('[data-grant-building]').length === 3", '二期门禁门栋选项');
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-grant-building]')].map((el) => el.getAttribute('data-grant-building'))"),
      ['6', '7', '8'],
    );
    assert.equal(await js("document.querySelector('[data-grant-building=\"6\"]').checked"), true, '默认勾选本房所在楼栋 6');
    assert.equal(await js("document.querySelector('[data-grant-building=\"7\"]').checked"), false);
    assert.ok((await js("document.querySelector('.sheet').textContent")).includes('本房所在楼栋'));
    assert.ok((await js('window.__calls')).some((item) => item.url === '/access-card-issuance/cards/1/grant-options'));
    await screenshot('access-grant-options.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭授权抽屉');

    // 旧后端没有 grant-options 时回退设备管理控制器列表：按 buildingNo 去重、默认本楼栋。
    await js("window.__grantFallback = true");
    const beforeFallback = (await js('window.__calls')).length;
    await click('[data-card-id="1"] .ac-grant-btn');
    await waitFor("!!document.querySelector('.sheet')", '授权楼栋抽屉（回退）');
    await waitFor("document.querySelectorAll('[data-grant-building]').length === 2", '回退控制器门栋');
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-grant-building]')].map((el) => el.getAttribute('data-grant-building'))"),
      ['6', '7'],
      '回退时从 /door/controllers 取 buildingNo 去重',
    );
    assert.equal(await js("document.querySelector('[data-grant-building=\"6\"]').checked"), true, '回退时也默认勾选本楼栋');
    const fallbackCalls = (await js('window.__calls')).slice(beforeFallback);
    assert.ok(fallbackCalls.some((item) => item.url === '/access-card-issuance/door/controllers' && Number(item.query?.communityId) === 2), '回退必须请求门禁控制器列表');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭授权抽屉（回退）');

    // 390/320 不横向溢出。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '390 出现横向溢出');
    await screenshot('access-cards-390.png');
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '320 出现横向溢出');
    await screenshot('access-cards-320.png');
  });
});

test('最近 30 笔一直 pending：自动重试 5 次后出现可点的重试入口，不会卡死在助手回传中', { timeout: 120000 }, async () => {
  await withPage(async ({ js, click, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁发卡页挂载');
    await js("document.querySelector('[data-testid=recent-toggle]').click()");
    // 用尽 5 次自动重试仍 pending：必须露出「重试」入口，并说明已暂停自动刷新。
    await waitFor("!!document.querySelector('.ac-recent-retry')", '自动重试耗尽后的重试入口', 15000);
    const bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('助手回传中'), '仍应显示助手回传中');
    assert.ok(bodyText.includes('助手回传较慢，已暂停自动刷新'), '应说明已暂停自动刷新');
    assert.ok(bodyText.includes('OLD00001'), 'pending 期间保留旧行');
    assert.ok(!bodyText.includes('暂无最近做卡记录'), 'pending 时不得显示暂无记录');
    const beforeCalls = (await js('window.__calls')).filter((item) => item.url === '/access-card-issuance/cards/recent');
    assert.equal(beforeCalls.length, 6, '首次 + 最多 5 次自动重试，实际 ' + beforeCalls.length);
    await screenshot('access-recent-stalled.png');
    await click('.ac-recent-retry');
    await waitFor(
      `window.__calls.filter((item) => item.url === '/access-card-issuance/cards/recent').length > ${beforeCalls.length}`,
      '点击重试后重新查询',
      4000,
    );
    await waitFor("!document.querySelector('.ac-recent-retry')", '重试后重试入口复位', 4000);
  }, '?recent-stall');
});

test('门禁操作区：已添加变绿、授权轮询完成自动关弹窗、最新任务中文+权限核验、失败保持', { timeout: 180000 }, async () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁发卡页挂载');
    await js("document.querySelector('[data-testid=recent-toggle]').click()");
    await waitFor("document.querySelectorAll('[data-testid=recent-block] tbody tr[data-card-id]').length === 10", '最近记录 ready', 15000);
    // 默认折叠：无详情行/日志，首列 ▸；行内按钮 stopPropagation 不展开。
    assert.equal(await js("!!document.querySelector('.ac-detail-row')"), false, '默认不应展开详情');
    assert.equal(await js("!!document.querySelector('[data-testid=task-log]')"), false, '默认不显示日志');
    assert.ok((await js("document.querySelector('[data-card-id=\"2\"]').children[0].textContent")).includes('▸'));
    // 已添加：绿色实心按钮、disabled、状态列不再挂重复 tag。
    const appliedBtn = await js("document.querySelector('[data-card-id=\"1\"] [data-testid=apply-btn]')?.outerHTML");
    assert.ok(appliedBtn.includes('已添加二期门禁系统'), '已添加按钮文案');
    assert.ok(appliedBtn.includes('data-applied=\"true\"'), '已添加按钮标记');
    assert.match(appliedBtn, /ac-applied-btn/);
    assert.match(appliedBtn, /disabled/);
    const statusCell = await js("document.querySelector('[data-card-id=\"1\"]').children[9].textContent");
    assert.equal(statusCell.includes('已添加二期门禁系统'), false, '状态列不再重复已添加 tag');
    // 未添加：可点，成功后立即变绿 disabled；点击按钮不触发行展开。
    assert.equal(await js("document.querySelector('[data-card-id=\"2\"] [data-testid=apply-btn]').disabled"), false);
    await js("document.querySelector('[data-card-id=\"2\"] [data-testid=apply-btn]').click()");
    await waitFor("window.__calls.some((item) => item.method === 'POST' && item.url === '/access-card-issuance/cards/2/apply-mdb')", 'apply-mdb 请求');
    await waitFor("document.querySelector('[data-card-id=\"2\"] [data-testid=apply-btn]')?.getAttribute('data-applied') === 'true'", '添加成功后按钮变绿');
    assert.equal(await js("document.querySelector('[data-card-id=\"2\"] [data-testid=apply-btn]').disabled"), true);
    assert.equal(await js("!!document.querySelector('.ac-detail-row')"), false, '点操作按钮不应展开行');
    await screenshot('access-applied-buttons.png');

    // 点击行展开：首次展开请求详情，日志倒序（最新在上），Access 库与控制器回执分开。
    await js("document.querySelector('[data-card-id=\"2\"] td:nth-child(2)').click()");
    await waitFor("!!document.querySelector('[data-testid=task-log]')", '点行展开日志');
    await waitFor("window.__calls.some((item) => item.url === '/access-card-issuance/cards/2')", '首次展开加载详情');
    const logText = await js("document.querySelector('[data-testid=task-log]').textContent");
    assert.ok(logText.includes('操作日志（最新在上）'));
    assert.ok(logText.includes('控制器已确认，响应 7EE1A2B3C4D5E6F7') && logText.includes('CardNO=21663417;ConsumerID=15951;GroupID=39'), '两种回执都显示');
    assert.ok(logText.includes('成功') && logText.includes('失败') && logText.includes('控制器未响应'), '中文成功/失败');
    assert.equal(/controller_uploaded|access_db_written|controller_failed|completed|failed/.test(logText), false, '日志禁止英文状态');
    const lines = await js("(async () => { const rows = [...document.querySelectorAll('[data-testid=task-log-line]')].map((el) => ({ text: el.textContent, ok: el.dataset.ok, op: el.dataset.operation })); return rows; })()");
    assert.equal(lines.length, 3, '三条动作日志');
    assert.match(lines[0].text, /授权楼栋.*50 号楼.*成功.*控制器已确认/, '最新在上：授权楼栋成功');
    assert.match(lines[1].text, /写入 Access 库.*50 号楼.*成功.*CardNO=21663417/, '写入 Access 库成功（access_db_written）');
    assert.equal(lines[1].text.includes('控制器已确认'), false, '写入 Access 库不得混入控制器回执');
    assert.equal(lines[0].text.includes('CardNO='), false, '授权楼栋不得混入 DB 记录');
    assert.equal(lines[2].ok, 'false');
    assert.match(lines[2].text, /失败.*控制器未响应/, 'controller_failed 映射失败');
    assert.ok((await js("document.querySelector('[data-testid=task-log-line] .ac-log-detail').getAttribute('title')")).includes('控制器已确认'));
    await screenshot('access-card-log-expanded.png');

    // 再点行收起；授权成功轮询结束后保持折叠。
    await js("document.querySelector('[data-card-id=\"2\"] td:nth-child(2)').click()");
    await waitFor("!document.querySelector('[data-testid=task-log]')", '再点行收起日志');
    await js("document.querySelector('[data-card-id=\"2\"] .ac-grant-btn').click()");
    await waitFor("!!document.querySelector('.sheet')", '授权弹窗');
    await waitFor("document.querySelectorAll('[data-grant-building]').length === 3", '授权门栋选项');
    await js("document.querySelector('[data-grant-building=\"7\"]').click()");
    await js("document.querySelector('.ac-dialog-foot .btn.p').click()");
    await waitFor("!!document.querySelector('[data-testid=grant-polling]')", '开始轮询控制器回执', 5000);
    await waitFor("window.__calls.filter((item) => item.url.startsWith('/access-card-issuance/history-authorizations/')).length >= 2", '轮询任务');
    await waitFor("!document.querySelector('.sheet')", '全部完成后自动关闭弹窗', 15000);
    assert.equal(await js("!!document.querySelector('.ac-detail-row')"), false, '授权完成后日志仍默认折叠');

    // 点行展开权限读回：重新核验按钮 POST 并展示结果。
    await js("document.querySelector('[data-card-id=\"2\"] td:nth-child(2)').click()");
    await waitFor("!!document.querySelector('[data-testid=permission-block]')", '展开权限读回');
    const permissionText = await js("document.querySelector('[data-testid=permission-block]').textContent");
    assert.ok(permissionText.includes('权限读回') && permissionText.includes('核验时间') && permissionText.includes('来源'));
    assert.ok(permissionText.includes('已授权') && permissionText.includes('未授权'), '逐栋权限读回');
    await js("document.querySelector('.ac-detail-row [data-testid=verify-grant-btn]').click()");
    await waitFor("window.__calls.some((item) => item.method === 'POST' && item.url === '/access-card-issuance/cards/2/verify-grant')", 'verify-grant 请求');
    await waitFor("(document.querySelector('[data-testid=permission-block]')?.textContent || '').includes('已读回 .88 门禁权限表')", '核验结果');
    await screenshot('access-grant-permission-1440.png');

    // 授权失败：保持弹窗，显示中文逐栋失败与「重新提交」。
    await js("window.__grantMode = 'fail'");
    await js("document.querySelector('[data-card-id=\"3\"] .ac-grant-btn').click()");
    await waitFor("!!document.querySelector('.sheet')", '失败场景授权弹窗');
    await waitFor("document.querySelectorAll('[data-grant-building]').length === 3", '失败场景门栋选项');
    await js("document.querySelector('.ac-dialog-foot .btn.p').click()");
    await waitFor("!!document.querySelector('[data-testid=grant-error]')", '授权失败错误提示', 10000);
    assert.ok(await js("!!document.querySelector('.sheet')"), '有失败/离线时不自动关闭');
    const failText = await js("document.querySelector('.sheet').textContent");
    assert.ok(failText.includes('失败') && failText.includes('控制器离线'), '逐栋中文失败结果');
    assert.equal(failText.includes('controller_failed'), false, '结果中不能出现英文状态');
    assert.ok((await js("document.querySelector('.ac-dialog-foot .btn.p').textContent")).includes('重新提交'));
    await screenshot('access-grant-failed.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭失败弹窗');

    // 390 无横向溢出。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '390 出现横向溢出');
    await screenshot('access-applied-390.png');
  });
});

test('最近30笔默认折叠在发卡历史之后、隐藏记录按普通行展示、1440 表格填满不滚动', { timeout: 120000 }, async () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await withPage(async ({ js, call, click, clickText, waitFor, screenshot }) => {
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor("!!document.querySelector('.findBar')", '门禁发卡页挂载');
    await pickHouse({ click, clickText, waitFor });
    await waitFor("!!document.querySelector('[data-testid=history-block]')", '发卡历史', 15000);
    // 默认折叠、无 recent 请求、位置在发卡历史之后。
    assert.equal(await js("!!document.querySelector('[data-testid=recent-block] tbody tr[data-card-id]')"), false, '最近30笔默认折叠');
    assert.equal(await js("window.__calls.filter((item) => item.url === '/access-card-issuance/cards/recent').length"), 0, '折叠时不得请求 recent');
    assert.ok((await js("document.querySelector('[data-testid=history-block]').getBoundingClientRect().top")) < (await js("document.querySelector('[data-testid=recent-block]').getBoundingClientRect().top")), '最近30笔在发卡历史之后');
    assert.ok((await js("document.querySelector('[data-testid=recent-toggle]').getAttribute('aria-expanded')")) === 'false');
    await js("document.querySelector('[data-testid=recent-block]').scrollIntoView({ block: 'end' })");
    await pause(200);
    await screenshot('access-recent-collapsed-1440.png');
    // 1440 发卡历史 11 列完整显示：容器无横向滚动，表格宽度≈容器。
    const historyFit = await js("(() => { const wrap = document.querySelector('[data-testid=history-block] .t-scroll'); const table = wrap.querySelector('table'); return { scroll: wrap.scrollWidth, client: wrap.clientWidth, table: table.getBoundingClientRect().width }; })()");
    assert.ok(historyFit.scroll <= historyFit.client + 1, '1440 发卡历史不应横向滚动：' + JSON.stringify(historyFit));
    assert.ok(historyFit.table >= historyFit.client - 2, '发卡历史表格应填满容器：' + JSON.stringify(historyFit));
    // 展开后才加载，表格/分页出现。
    await js("document.querySelector('[data-testid=recent-toggle]').click()");
    await waitFor("document.querySelectorAll('[data-testid=recent-block] tbody tr[data-card-id]').length === 10", '展开后加载最近30笔', 15000);
    assert.ok(await js("!!document.querySelector('[data-testid=recent-pager]')"));
    const recentFit = await js("(() => { const wrap = document.querySelector('[data-testid=recent-block] .t-scroll'); return { scroll: wrap.scrollWidth, client: wrap.clientWidth }; })()");
    assert.ok(recentFit.scroll <= recentFit.client + 1, '1440 最近30笔不应横向滚动：' + JSON.stringify(recentFit));
    await js("document.querySelector('[data-testid=recent-block]').scrollIntoView({ block: 'start' })");
    await pause(200);
    await screenshot('access-recent-expanded-1440.png');
    // 已隐藏记录按普通行：无「已隐藏」文案/class，状态在用，操作可用，房号去前缀。
    const hiddenRow = await js("(() => { const row = document.querySelector('[data-card-id=\"3\"]'); return { text: row.textContent, cls: row.className, room: row.children[2].textContent.trim(), status: row.children[9].textContent.trim(), applyDisabled: row.querySelector('[data-testid=apply-btn]').disabled }; })()");
    assert.equal(hiddenRow.text.includes('已隐藏'), false, '隐藏记录不再显示已隐藏');
    assert.equal(hiddenRow.cls.includes('ac-hidden-row'), false);
    assert.equal(hiddenRow.room, '228/6/502', '房号去掉已隐藏前缀');
    assert.equal(hiddenRow.status, '在用');
    assert.equal(hiddenRow.applyDisabled, false, '隐藏记录操作可用');
    // 390 页面不溢出，表格内部可滚动。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '390 页面横向溢出');
    assert.ok(await js("(() => { const wrap = document.querySelector('[data-testid=recent-block] .t-scroll'); return wrap && wrap.scrollWidth >= wrap.clientWidth; })()"), '窄屏表格容器内部滚动');
    await screenshot('access-recent-390.png');
  });
});

test('发卡历史：personCreatedAt 倒序、全量倒序序号 30..21/20..11、字段升级提示与列头 title', { timeout: 120000 }, async () => {
  await withPage(async ({ js, click, clickText, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.findBar')", '门禁发卡页挂载');
    await pickHouse({ click, clickText, waitFor });
    await waitFor("document.querySelectorAll('[data-testid=history-block] tbody tr[data-card-id]').length === 10", '发卡历史第 1 页 10 行');
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-testid=history-block] tbody tr[data-card-id]')].map((row) => row.children[0].textContent.trim().replace(/[▸▾]/g, ''))"),
      ['30', '29', '28', '27', '26', '25', '24', '23', '22', '21'],
      '第 1 页序号按全量倒序 30..21',
    );
    assert.ok((await js("document.querySelector('[data-testid=history-block] .ac-history-table').textContent")).includes('10930'), '最新（personCreatedAt 最大）的行在第一页');
    const headers = await js("[...document.querySelectorAll('[data-testid=history-block] thead th')].map((th) => ({ text: th.textContent.trim(), title: th.getAttribute('title') || '' }))");
    assert.equal(headers.length, 11);
    for (const name of ['最后刷卡时间', '出入口']) {
      const header = headers.find((item) => item.text === name);
      assert.ok(header && header.title.includes('2021 年后二期') && header.title.includes('需升级现场助手'), name + ' 列头应同时说明 .88 未接入与升级提示');
    }
    const personCreatedHeader = headers.find((item) => item.text === '人事资料添加时间');
    assert.ok(personCreatedHeader && personCreatedHeader.title.includes('现场助手'), '人事资料添加时间列头应有助手回传说明');
    // 第 1 页混三种行：130 有 2020 年 .80 刷卡记录；129 行级 fieldsIncomplete=true；128 字段已回传但无记录。
    const historyCells = async (id) => js(`[...document.querySelectorAll('[data-testid=history-block] tbody tr[data-card-id="${id}"] td')].map((td) => ({ text: td.textContent.trim(), title: td.querySelector('[title]')?.getAttribute('title') || '', upgrade: !!td.querySelector('[data-upgrade-hint]') }))`);
    const swipeRow = await historyCells(130);
    assert.ok(swipeRow[7].text.includes('2020-07-29'), '有 .80 刷卡记录应显示最后刷卡时间：' + swipeRow[7].text);
    assert.equal(swipeRow[8].text, '198弄6号大门', '有 .80 刷卡记录应显示出入口');
    const incompleteRow = await historyCells(129);
    assert.equal(incompleteRow[7].text, '需升级现场助手（.80）', '行级 fieldsIncomplete=true 仍应提示升级');
    assert.equal(incompleteRow[8].text, '需升级现场助手（.80）');
    const noRecordRow = await historyCells(128);
    assert.equal(noRecordRow[7].text, '—', 'fieldsIncomplete=false 且无 .80 记录应显示 —');
    assert.equal(noRecordRow[8].text, '—');
    assert.ok(noRecordRow[7].title.includes('2021 年后二期') && noRecordRow[8].title.includes('2021 年后二期'), '无记录 title 应说明 .88 未接入');
    assert.ok(!noRecordRow.some((cell) => cell.text.includes('需升级现场助手')), '字段已回传时无 .80 记录不得提示升级');
    assert.ok((await js("document.querySelector('[data-testid=history-block] .ac-history-table').textContent")).includes('需升级现场助手（.80）'), 'fieldsIncomplete 行显示升级提示');
    await js("document.querySelector('[data-testid=history-block]').scrollIntoView({ block: 'center' })");
    await js("new Promise((resolve) => setTimeout(resolve, 120))");
    await screenshot('access-history-fields.png');
    await js("scrollTo(0, 0)");
    await js("new Promise((resolve) => setTimeout(resolve, 80))");
    await screenshot('access-history-page1.png');
    await js("(() => { const buttons = [...document.querySelectorAll('[data-testid=history-pager] button')]; buttons.find((b) => b.textContent.trim() === '2').click(); })()");
    await waitFor("document.querySelector('[data-testid=history-block] tbody tr[data-card-id] td')?.textContent.trim().replace(/[▸▾]/g, '') === '20'", '发卡历史第 2 页');
    assert.deepEqual(
      await js("[...document.querySelectorAll('[data-testid=history-block] tbody tr[data-card-id]')].map((row) => row.children[0].textContent.trim().replace(/[▸▾]/g, ''))"),
      ['20', '19', '18', '17', '16', '15', '14', '13', '12', '11'],
      '第 2 页序号 20..11',
    );
    await screenshot('access-history-page2.png');
  });
});

