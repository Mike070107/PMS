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
const evidenceDir = path.resolve(app, '../../../..', 'pms-reports-evidence');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildFixture() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const build = esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'reports-fee-browser.tsx')],
    bundle: true, format: 'iife', jsx: 'automatic', write: false,
    outfile: path.join(evidenceDir, 'fixture.js'),
    alias: {
      '@/lib/auth': path.join(__dirname, 'erp-browser-auth.ts'),
      '@/lib/perm': path.join(__dirname, 'erp-browser-auth.ts'),
      '@': path.join(app, 'src'),
      '@pms/api-client': path.join(__dirname, 'erp-browser-api.ts'),
      '@pms/shared-types': path.join(app, '../../packages/shared-types/src/index.ts'),
    },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env.VITE_LEGACY_BASE': '""',
      'import.meta.env.BASE_URL': '"/"',
    },
  });
  for (const file of build.outputFiles) fs.writeFileSync(file.path, file.contents);
  fs.writeFileSync(path.join(evidenceDir, 'fixture.html'),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
}

async function withPage(run) {
  buildFixture();
  const server = http.createServer((request, response) => {
    const name = request.url.split('?')[0].slice(1);
    if (!['fixture.html', 'fixture.css', 'fixture.js'].includes(name)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', name.endsWith('js') ? 'text/javascript' : name.endsWith('css') ? 'text/css' : 'text/html;charset=utf-8');
    response.end(fs.readFileSync(path.join(evidenceDir, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture.html`;
  const profile = path.join(evidenceDir, 'chrome-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', url], { stdio: 'ignore' });
  let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const parsed = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
        if (Number.isInteger(parsed) && parsed > 0) { port = parsed; break; }
      } catch { /* retry */ }
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
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(Error(method + ' 超时')), 15000);
      pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result); });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const js = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression, label, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await js(expression)) return; await pause(80); }
      assert.fail('等待超时：' + label);
    };
    const screenshot = async (name) => {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(shot.data, 'base64'));
    };
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await run({ js, call, waitFor, screenshot });
  } finally {
    socket?.close();
    child.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('收费报表：PMS/旧系统来源、数字下钻明细、分页/空态、导出、窄屏', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("document.querySelectorAll('.erp-report-kpis .stat').length === 4", '收费 KPI', 25000);
    const note = await js("document.querySelector('[data-testid=fee-source-note]').textContent");
    assert.match(note, /锦川公寓等 PMS 收费小区.*枫桦景苑一期\/二期\/上海新家为旧系统 MIS 实收/);
    const communityTable = await js("document.querySelector('[data-testid=fee-breakdown-community]').textContent");
    assert.ok(communityTable.includes('锦川公寓') && communityTable.includes('PMS'), 'PMS 来源行');
    assert.ok(communityTable.includes('枫桦景苑一期') && communityTable.includes('旧系统'), '旧系统来源行');
    assert.ok(await js("!!document.querySelector('[data-testid=export-fees]')"), '导出 Excel 保留');

    const open = async (selector) => {
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor("!!document.querySelector('[data-testid=fee-detail-sheet]')", '明细抽屉');
      await waitFor("!!document.querySelector('[data-testid=fee-detail-table]') || !!document.querySelector('[data-testid=fee-detail-empty]')", '明细内容');
    };
    const close = async () => { await js("document.querySelector('.fee-detail-close').click()"); await waitFor("!document.querySelector('[data-testid=fee-detail-sheet]')", '关闭明细'); };
    const cases = [
      ['community', '01', 'community:01', 300000],
      ['fee', 'rent', 'fee:rent', 800000],
      ['method', 'cash', 'method:cash', 800000],
      ['cashier', '合成员工', 'cashier:合成员工', 800000],
    ];
    for (const [dimension, key, expected, amount] of cases) {
      await open(`[data-testid=fee-breakdown-${dimension}] [data-key="${key}"][data-fee-detail]`);
      const query = await js("window.__calls.filter(o=>o.url==='/fees/reports/detail').at(-1).query");
      assert.equal(`${query.dimension}:${query.key}`, expected, JSON.stringify(query));
      assert.equal(query.limit, 200);
      if (dimension === 'community') assert.equal(query.source, 'mis', '旧系统小区下钻带 source=mis');
      const headers = await js("[...document.querySelectorAll('[data-testid=fee-detail-table] thead th')].map(e=>e.textContent.trim())");
      assert.deepEqual(headers, ['来源', '日期', '管理处/小区', '地址', '业主', '收费项目', '金额', '收款方式', '收款人', '票据/入库单号']);
      assert.ok(await js("!!document.querySelector('[data-testid=fee-detail-table] tbody tr[data-source=\"mis\"]')"), '明细旧系统来源标签');
      assert.equal(await js("document.querySelector('[data-testid=fee-detail-total]').dataset.cellAmount"), String(amount), '合计=点击单元格金额');
      await close();
    }

    // 趋势某天：点日期行金额 → dimension=day
    await js("document.querySelector('details summary').click()");
    await waitFor("!!document.querySelector('[data-testid=fee-trend-table]')", '趋势明细表');
    await open('[data-testid=fee-trend-table] [data-key="2026-11-01"]');
    const dayQuery = await js("window.__calls.filter(o=>o.url==='/fees/reports/detail').at(-1).query");
    assert.equal(dayQuery.dimension, 'day');
    assert.equal(dayQuery.key, '2026-11-01');
    assert.match(await js("document.querySelector('[data-testid=fee-detail-sheet]').textContent"), /明细清单 · 2026-11-01/);
    await screenshot('reports-fee-detail-1440.png');
    // 分页：count 450 → 下一页 offset=200，显示总笔数
    await js("document.querySelector('[data-testid=fee-detail-next]').click()");
    await waitFor("window.__calls.filter(o=>o.url==='/fees/reports/detail').at(-1).query.offset === 200", '明细下一页 offset=200');
    await waitFor("(document.querySelector('[data-testid=fee-detail-sheet]')?.textContent||'').includes('共 450 笔')", '明细总数');
    assert.match(await js("document.querySelector('[data-testid=fee-detail-sheet]').textContent"), /共 450 笔/);
    await close();

    // 空数据：显示「该条件下无明细」，不伪造行
    await js("window.__feeDetailEmpty = true");
    await open('[data-testid=fee-breakdown-fee] [data-key="rent"]');
    assert.equal(await js("document.querySelector('[data-testid=fee-detail-empty]').textContent.trim()"), '该条件下无明细');
    await close();
    await js("window.__feeDetailEmpty = false");

    // 390/320 无横向溢出，明细抽屉不超宽
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(300);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收费报表 390 横向溢出');
    await open('[data-testid=fee-breakdown-fee] [data-key="rent"]');
    assert.ok(await js("document.querySelector('[data-testid=fee-detail-sheet]').getBoundingClientRect().right <= innerWidth + 1"), '390 明细抽屉不超宽');
    await screenshot('reports-fee-detail-390.png');
    await close();
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(300);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '收费报表 320 横向溢出');
  });
});
