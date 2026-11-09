const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const ts = require('typescript');

const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const evidenceDir = path.resolve(app, '../../../..', 'pms-statistics-evidence');
// 应收截止默认「当前年份 12 月」，与旧系统截图口径一致（镜像同步月份不能当截止月）。
const expectedAsOfPeriod = `${new Date().getFullYear()}12`;
// MIS FWXZK 全字典 01–13；旧系统截图口径默认排除 06 空房。
const expectedDefaultNatures = '01,02,03,04,05,07,08,09,10,11,12,13';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadStatisticsLib() {
  const source = fs.readFileSync(path.join(app, 'src/lib/statistics.ts'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports });
  return module.exports;
}

test('统计汇总金额/CSV 纯函数：整数分格式化、UTF-8 BOM、筛选参数', () => {
  const lib = loadStatisticsLib();
  assert.equal(lib.fmtCents(74518210), '¥745,182.10');
  assert.equal(lib.fmtCents(0), '¥0.00');
  assert.equal(lib.fmtCents(null), '¥0.00');
  assert.equal(lib.fmtCents(15930), '¥159.30');
  assert.equal(lib.fmtArea(79.67), '79.67 ㎡');
  assert.equal(lib.fmtPeriod('202410'), '2024-10');

  const filters = {
    type: 'arrears', officeCodes: ['02'], feeCodes: ['01'], natures: ['01', '04'],
    yearFrom: 2004, yearTo: 2026, asOfPeriod: '202611', paidDateTo: '2026-11-09',
  };
  const query = lib.annualQueryParams(filters);
  assert.deepEqual(JSON.parse(JSON.stringify(query)), {
    type: 'arrears', officeCodes: '02', feeCodes: '01', natures: '01,04',
    yearFrom: 2004, yearTo: 2026, asOfPeriod: '202611',
  });

  // 欠费报表不传收款截止；实收才传；明细与年度使用同一组截止参数。
  assert.equal(lib.annualQueryParams({ ...filters, type: 'arrears', paidDateTo: '2026-11-09' }).paidDateTo, undefined);
  assert.equal(lib.annualQueryParams({ ...filters, type: 'received', paidDateTo: '2026-11-09' }).paidDateTo, '2026-11-09');
  const detailParams = lib.detailQueryParams({
    type: 'arrears', officeCode: '02', year: 2014, feeCodes: ['01'], natures: ['01', '04'],
    asOfPeriod: '202612', paidDateTo: '2026-11-09',
  });
  assert.equal(detailParams.asOfPeriod, '202612');
  assert.equal(detailParams.paidDateTo, undefined);
  assert.equal(lib.detailQueryParams({
    type: 'received', officeCode: '02', year: 2014, feeCodes: ['01'], natures: ['01'],
    asOfPeriod: '202612', paidDateTo: '2026-11-09',
  }).paidDateTo, '2026-11-09');

  const annual = {
    type: 'arrears',
    columns: [2011, 2014],
    rows: [{ officeCode: '02', officeName: '枫桦景苑二期A', cells: { 2011: 92100, 2014: 47790 }, totalCents: 139890 }],
    subtotal: { cells: { 2011: 92100, 2014: 47790 }, totalCents: 139890 },
    dataAsOf: '2026-11-09T21:00:00+08:00',
  };
  const csv = lib.annualCsv(annual, {
    dataAsOf: annual.dataAsOf,
    filters,
    offices: [{ officeCode: '02', name: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期' }],
    feeItems: [{ code: '01', name: '管理费' }],
    natures: [{ code: '01', name: '商品房' }, { code: '04', name: '配套用房' }],
  });
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'CSV 必须带 UTF-8 BOM');
  assert.ok(csv.includes('项目欠费年度汇总'));
  assert.ok(csv.includes('管理处,2011,2014,合计'), 'CSV 要有年度表头和合计列');
  assert.ok(csv.includes('枫桦景苑二期A,921.00,477.90,1398.90'));
  assert.ok(csv.includes('小计,921.00,477.90,1398.90'));
  assert.ok(csv.includes('管理费'));
});

function buildFixture() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const build = esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'statistics-browser.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outfile: path.join(evidenceDir, 'fixture.js'),
    alias: {
      '@': path.join(app, 'src'),
      '@pms/api-client': path.join(__dirname, 'statistics-browser-api.ts'),
      '@pms/shared-types': path.join(app, '../../packages/shared-types/src/index.ts'),
    },
    define: {
      'process.env.NODE_ENV': '"development"',
      'import.meta.env.VITE_LEGACY_BASE': '""',
      'import.meta.env.BASE_URL': '"/"',
      'import.meta.env.VITE_API_BASE_URL': '"/api/v1"',
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
    assert.ok(tab, 'Chrome 没有打开统计夹具页面');
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

test('统计汇总：默认年度表、筛选参数、三级下钻、错误重试、CSV 导出、窄屏卡片', { timeout: 180000 }, async () => {
  await withPage(async ({ js, call, waitFor, screenshot }) => {
    await waitFor("!!document.querySelector('.stats')", '统计页挂载', 25000);
    await waitFor("!!document.querySelector('.stats-annual-table')", '默认年度汇总表', 25000);

    // 报表目录：两张启用、其余灰字「待接入」，不是假按钮。
    assert.equal(await js("document.querySelector('[data-report-type=received]').classList.contains('on')"), true);
    assert.ok(await js("!!document.querySelector('[data-report-type=arrears]')"));
    assert.ok(await js("document.querySelectorAll('.stats-report-pending').length >= 15"), '待接入报表要用灰字列出');
    assert.equal(await js("[...document.querySelectorAll('button')].some((e) => e.textContent.includes('收费汇总'))"), false, '待接入报表不能是按钮');
    assert.ok(await js("[...document.querySelectorAll('.stats-report-pending')].every((e) => (e.title || '').includes('待接入'))"));

    // 默认实收年度表：年度表头 2004..2026 + 合计、4 个管理处行、合计/小计、数据截止。
    const headers = await js("[...document.querySelectorAll('.stats-annual-table thead th')].map((e) => e.textContent.trim())");
    assert.ok(headers.includes('2004') && headers.includes('2026') && headers.includes('合计'), '年度表头缺失：' + JSON.stringify(headers.slice(0, 6)));
    assert.equal(await js("document.querySelectorAll('.stats-annual-table tbody tr[data-office-row]').length"), 4);
    assert.ok(await js("!!document.querySelector('[data-testid=stats-subtotal-row]')"));
    assert.ok((await js("document.querySelector('[data-office-row=\"02\"]').textContent")).includes('¥7,435,962.00'), '实收 02 合计应按后端返回');
    const bodyText = await js('document.body.textContent');
    assert.ok(bodyText.includes('数据截止'), '要显示数据截止时间');
    assert.ok(bodyText.includes('项目实收年度汇总'));
    assert.ok(bodyText.includes('按收费发生时点性质统计'), '筛选面板要说明房屋性质按收费时点统计');
    assert.equal(await js("document.querySelectorAll('[data-nature-code]').length"), 13, '房屋性质应渲染 FWXZK 全字典 01–13');
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), false, '空房 06 默认不勾选');
    assert.equal(await js("document.querySelector('[data-nature-code=\"05\"]').checked"), true);
    assert.equal(await js("document.querySelector('[data-nature-code=\"13\"]').checked"), true);
    const receivedQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual').slice(-1)[0].query");
    assert.equal(receivedQuery.type, 'received');
    assert.equal(receivedQuery.asOfPeriod, expectedAsOfPeriod, '应收截止默认当前年份 12 月');
    assert.equal(receivedQuery.paidDateTo, undefined, '收款截止默认留空，不限制实收');
    assert.equal(receivedQuery.natures, expectedDefaultNatures, '默认房屋性质 = 全字典排除 06 空房');
    assert.ok(!receivedQuery.natures.split(',').includes('06'), '默认请求不能带 06 空房');
    assert.ok(receivedQuery.natures.split(',').includes('05') && receivedQuery.natures.split(',').includes('07'), '默认请求要含 05/07 等非空房性质');
    await screenshot('statistics-received-1440.png');

    // 悬浮筛选可收纳：收起后数据区变宽、面板消失；localStorage 记住状态。
    assert.ok(await js("!!document.querySelector('.stats-filter-float')"), '桌面默认展开筛选浮层');
    assert.equal(await js("localStorage.getItem('statistics.filters.collapsed')"), null);
    const widthExpanded = await js("document.querySelector('.stats-main').clientWidth");
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await pause(300);
    assert.equal(await js("!!document.querySelector('.stats-filters')"), false, '收起后筛选面板应隐藏');
    assert.equal(await js("localStorage.getItem('statistics.filters.collapsed')"), '1', '收起状态应写入 localStorage');
    const widthCollapsed = await js("document.querySelector('.stats-main').clientWidth");
    assert.ok(widthCollapsed > widthExpanded, `收起后数据区应变宽（${widthExpanded} → ${widthCollapsed}）`);
    assert.ok((await js("document.querySelector('[data-testid=stats-filter-toggle]').textContent")).includes('筛选'));
    await screenshot('statistics-filters-collapsed-1440.png');
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await pause(300);
    assert.ok(await js("!!document.querySelector('.stats-filters')"), '再次点击应展开筛选');
    assert.equal(await js("localStorage.getItem('statistics.filters.collapsed')"), '0');

    // 编号独立列 + 管理处名称分列；表头/单元格对齐一致；表格线；左两列 sticky。
    const headTexts = await js("[...document.querySelectorAll('.stats-annual-table thead th')].map((e) => e.textContent.trim())");
    assert.deepEqual(headTexts.slice(0, 2), ['编号', '管理处'], '首列应为编号、第二列管理处');
    assert.equal(await js("document.querySelector('.stats-annual-table tbody td.stats-index-col').textContent.trim()"), '01');
    const officeCell = await js("document.querySelector('.stats-annual-table tbody td.stats-office-col').textContent");
    assert.ok(officeCell.includes('枫桦景苑一期'));
    assert.equal(officeCell.includes('01'), false, '管理处名称列不再混排编号');
    const align = await js(`(() => {
      const th = [...document.querySelectorAll('.stats-annual-table thead th')].find((e) => e.textContent.trim() === '2004');
      const totalTh = [...document.querySelectorAll('.stats-annual-table thead th')].pop();
      return {
        yearTh: getComputedStyle(th).textAlign,
        yearTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-year-col')).textAlign,
        totalTh: getComputedStyle(totalTh).textAlign,
        totalTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-total-col')).textAlign,
        indexTh: getComputedStyle(document.querySelector('.stats-annual-table thead th.stats-index-col')).textAlign,
        indexTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-index-col')).textAlign,
        officeTh: getComputedStyle(document.querySelector('.stats-annual-table thead th.stats-office-col')).textAlign,
        officeTd: getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-office-col')).textAlign,
      };
    })()`);
    assert.equal(align.yearTh, 'right', '年度表头应右对齐');
    assert.equal(align.yearTd, 'right', '年度单元格应右对齐');
    assert.equal(align.totalTh, 'right', '合计表头应右对齐');
    assert.equal(align.totalTd, 'right', '合计单元格应右对齐');
    assert.equal(align.indexTh, align.indexTd, '编号表头与单元格对齐一致');
    assert.equal(align.officeTh, 'left', '管理处表头应左对齐');
    assert.equal(align.officeTd, 'left', '管理处单元格应左对齐');
    const borders = await js(`(() => {
      const td = document.querySelector('.stats-annual-table tbody td');
      const th = document.querySelector('.stats-annual-table thead th');
      return {
        td: parseFloat(getComputedStyle(td).borderBottomWidth) + parseFloat(getComputedStyle(td).borderRightWidth),
        th: parseFloat(getComputedStyle(th).borderBottomWidth),
      };
    })()`);
    assert.ok(borders.td > 0 && borders.th > 0, '表头/单元格应有表格线');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-index-col')).position"), 'sticky');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-office-col')).position"), 'sticky');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-annual-table tbody td.stats-office-col')).left"), '56px', '管理处列应紧贴编号列左侧固定');

    // 切到项目欠费年度汇总：02×2014=¥477.90，02 合计 ¥745,182.10（生产验收基准）。
    await js("document.querySelector('[data-report-type=arrears]').click()");
    await waitFor("document.querySelector('[data-office-code=\"02\"][data-year=\"2014\"]')?.textContent.includes('¥477.90')", '欠费 02×2014 单元格');
    assert.ok((await js("document.querySelector('[data-office-row=\"02\"]').textContent")).includes('¥745,182.10'));
    assert.ok((await js('document.body.textContent')).includes('项目欠费年度汇总'));
    assert.ok((await js('document.body.textContent')).includes('已知差异'), '01 管理处差异要在页面标注');
    for (const [year, amount] of [['2011', '¥921.00'], ['2012', '¥307.00'], ['2014', '¥477.90'], ['2025', '¥16,595.00'], ['2026', '¥726,881.20']]) {
      assert.equal(await js(`document.querySelector('[data-office-code="02"][data-year="${year}"]').textContent.trim()`), amount, `02×${year} 年度金额应对上生产验收基准`);
    }
    await screenshot('statistics-arrears-1440.png');

    // 筛选变更不自动请求；勾 02 管理处 + 管理费后点「统计」，请求参数正确。
    const beforeCalls = await js("window.__calls.filter((c) => c.url === '/statistics/annual').length");
    await js("document.querySelector('[data-action=offices-clear]').click()");
    await js("document.querySelector('[data-office-code=\"02\"]').click()");
    await js("document.querySelector('[data-action=fees-clear]').click()");
    await js("document.querySelector('[data-fee-code=\"01\"]').click()");
    await pause(300);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/annual').length"), beforeCalls, '改筛选不能自动请求');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("(() => { const list = window.__calls.filter((c) => c.url === '/statistics/annual'); const last = list[list.length - 1]; return last && last.query.officeCodes === '02' && last.query.feeCodes === '01'; })()", '筛选后的年度请求');
    const annualQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual').slice(-1)[0].query");
    assert.equal(annualQuery.type, 'arrears');
    assert.equal(annualQuery.officeCodes, '02');
    assert.equal(annualQuery.feeCodes, '01');
    assert.equal(annualQuery.natures, expectedDefaultNatures, '筛选后仍默认排除 06 空房');
    assert.ok(!annualQuery.natures.split(',').includes('06'));
    assert.equal(annualQuery.yearFrom, 2004);
    assert.equal(annualQuery.yearTo, 2026);
    assert.equal(annualQuery.asOfPeriod, expectedAsOfPeriod);
    assert.equal(annualQuery.paidDateTo, undefined, '欠费报表不传收款截止日期');
    await waitFor("document.querySelectorAll('.stats-annual-table tbody tr[data-office-row]').length === 1", '筛选后只剩 02');
    assert.equal(await js("document.querySelector('[data-office-code=\"02\"][data-year=\"2014\"]').textContent.trim()"), '¥477.90');
    await screenshot('statistics-filtered-1440.png');

    // 三级下钻：单元格 → 房屋明细（合计与单元格一致）→ 逐笔账单。
    await js("document.querySelector('[data-office-code=\"02\"][data-year=\"2014\"]').click()");
    await waitFor("!!document.querySelector('.sheet')", '明细抽屉');
    await waitFor("!!document.querySelector('[data-testid=stats-detail-total]')", '明细合计');
    assert.equal(await js("document.querySelector('[data-testid=stats-detail-cell-amount]').textContent.trim()"), '¥477.90');
    assert.equal(await js("document.querySelector('[data-testid=stats-detail-total]').textContent.trim()"), '¥477.90', '明细合计必须等于单元格');
    assert.equal(
      await js("getComputedStyle([...document.querySelectorAll('.stats-detail-table thead th')].find((e) => e.classList.contains('stats-num'))).textAlign"),
      'right',
      '明细表头金额列应右对齐',
    );
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-detail-table tbody td.stats-num')).textAlign"), 'right', '明细金额单元格应右对齐');
    const sheetText = await js("document.querySelector('.sheet').textContent");
    assert.ok(sheetText.includes('宝秀路719号719'));
    assert.ok(sheetText.includes('79.67 ㎡'));
    assert.ok(sheetText.includes('201410-201412'));
    assert.ok(sheetText.includes('欠费年月范围'));
    const detailQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail').slice(-1)[0].query");
    assert.equal(detailQuery.type, 'arrears');
    assert.equal(detailQuery.officeCode, '02');
    assert.equal(detailQuery.year, 2014);
    assert.equal(detailQuery.feeCodes, '01');
    assert.equal(detailQuery.asOfPeriod, expectedAsOfPeriod, '明细必须带与年度表相同的应收截止');
    assert.equal(detailQuery.paidDateTo, undefined, '欠费明细不传收款截止日期');
    assert.equal(detailQuery.natures, expectedDefaultNatures, '明细与年度表用同一组房屋性质（默认排除 06）');
    assert.ok(!detailQuery.natures.split(',').includes('06'));
    await screenshot('statistics-detail-1440.png');

    await js("document.querySelector('.stats-detail-table tbody tr').click()");
    await waitFor("!!document.querySelector('[data-testid=stats-bills-total]')", '逐笔账单表');
    assert.equal(await js("document.querySelectorAll('.stats-bills-row').length"), 3);
    assert.deepEqual(
      await js("[...document.querySelectorAll('.stats-bills-row')].map((row) => row.children[0].textContent.trim())"),
      ['2024-10', '2024-11', '2024-12'],
    );
    assert.deepEqual(
      await js("[...document.querySelectorAll('.stats-bills-row')].map((row) => row.children[2].textContent.trim())"),
      ['¥159.30', '¥159.30', '¥159.30'],
    );
    assert.equal(await js("document.querySelector('[data-testid=stats-bills-total]').textContent.trim()"), '¥477.90');
    const billsQuery = await js("window.__calls.filter((c) => c.url === '/statistics/annual/detail/bills').slice(-1)[0].query");
    assert.equal(billsQuery.sId, 719, 'detail 行 sId 是数字，逐笔请求必须原样带回来');
    assert.equal(billsQuery.asOfPeriod, expectedAsOfPeriod, '逐笔必须带与年度表相同的应收截止');
    assert.equal(billsQuery.paidDateTo, undefined, '欠费逐笔不传收款截止日期');
    await screenshot('statistics-bills-1440.png');
    await js("document.querySelector('.sheet .x').click()");
    await waitFor("!document.querySelector('.sheet')", '关闭明细抽屉');

    // 错误态：可见错误 + 重试；恢复后重试能取回表格。
    await js('window.__annualFail = true');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("document.body.textContent.includes('统计读取失败')", '统计错误态');
    assert.ok(await js("[...document.querySelectorAll('.stats-result button')].some((e) => e.textContent.trim() === '重试')"), '错误态要有重试');
    await screenshot('statistics-error-1440.png');
    await js('window.__annualFail = false');
    await js("(() => { const button = [...document.querySelectorAll('.stats-result button')].find((e) => e.textContent.trim() === '重试'); button.click(); })()");
    await waitFor("!!document.querySelector('.stats-annual-table')", '重试后恢复年度表');

    // 未镜像：annual.available=false + message 时优先显示后端说明，不渲染空表/通用「暂无数据」。
    await js('window.__annualUnavailable = true');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("document.body.textContent.includes('MIS 镜像本期未同步')", '未镜像说明');
    assert.equal(await js("!!document.querySelector('.stats-annual-table')"), false, '未镜像时不能渲染空表');
    assert.equal(await js("document.body.textContent.includes('当前筛选没有可汇总的数据')"), false, '未镜像时不能只说暂无数据');
    await screenshot('statistics-unavailable-1440.png');
    await js('window.__annualUnavailable = false');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    await waitFor("!!document.querySelector('.stats-annual-table')", '未镜像恢复后年度表');

    // 导出 CSV：UTF-8 BOM、含当前报表/筛选与合计行。
    await js("(() => { window.__blobs = []; const original = window.URL.createObjectURL.bind(window.URL); window.URL.createObjectURL = (blob) => { window.__blobs.push(blob); return original(blob); }; })()");
    await js("document.querySelector('[data-testid=stats-export]').click()");
    await waitFor("window.__blobs.length >= 1", 'CSV Blob');
    const csv = await js("(async () => { const blob = window.__blobs[0]; const bytes = new Uint8Array(await blob.arrayBuffer()).slice(0, 3); const text = await blob.text(); return { bom: [...bytes], report: text.includes('项目欠费年度汇总'), header: text.includes('管理处,2004'), subtotal: text.includes('小计'), length: text.length }; })()");
    assert.deepEqual(csv.bom, [0xEF, 0xBB, 0xBF], 'CSV 必须带 UTF-8 BOM');
    assert.ok(csv.report, 'CSV 应含当前报表名');
    assert.ok(csv.header, 'CSV 应含年度表头');
    assert.ok(csv.subtotal, 'CSV 应含小计行');
    assert.ok(csv.length > 200);
    // 等导出 toast 消失再截窄屏图，避免浮层遮住表格表头。
    await pause(2600);

    // 窄屏（≤900）：清理记忆后重载，筛选应默认收起为顶部「筛选」按钮；点开为浮层抽屉，卡片模式保持。
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await js("localStorage.removeItem('statistics.filters.collapsed')");
    await call('Page.reload', { ignoreCache: true });
    await pause(900);
    await waitFor("!!document.querySelector('.stats')", '窄屏重载统计页', 25000);
    await waitFor("document.querySelectorAll('.stats-office-card').length >= 1", '窄屏卡片', 25000);
    assert.equal(await js("!!document.querySelector('.stats-filters')"), false, '窄屏默认收起筛选面板');
    assert.ok((await js("document.querySelector('[data-testid=stats-filter-toggle]').textContent")).includes('筛选'));
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '390 窄屏出现横向溢出');
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-table-scroll')).display"), 'none');
    assert.notEqual(await js("getComputedStyle(document.querySelector('.stats-annual-cards')).display"), 'none');
    await js("document.querySelector('.stats-annual-cards').scrollIntoView({ block: 'center' })");
    await pause(200);
    await screenshot('statistics-390-collapsed.png');
    await js('window.scrollTo(0, 0)');
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await waitFor("!!document.querySelector('.stats-filters')", '窄屏筛选浮层', 8000);
    assert.equal(await js("getComputedStyle(document.querySelector('.stats-filter-mask')).display"), 'block', '窄屏筛选浮层应有遮罩');
    await screenshot('statistics-390-filters-open.png');
    await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
    await pause(300);
    assert.equal(await js("!!document.querySelector('.stats-filters')"), false, '窄屏再次点击应收起筛选');

    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(350);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '320 窄屏出现横向溢出');
    assert.ok(await js("!!document.querySelector('.stats-card-year')"));
    await screenshot('statistics-320.png');

    // 重置回到默认：房屋性质仍排除 06 空房，管理处/收费项目恢复全选；重置本身不自动请求。
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await pause(400);
    if (!(await js("!!document.querySelector('.stats-filters')"))) {
      await js("document.querySelector('[data-testid=stats-filter-toggle]').click()");
      await waitFor("!!document.querySelector('.stats-filters')", '桌面筛选面板恢复', 8000);
    }
    const callsBeforeReset = await js("window.__calls.filter((c) => c.url === '/statistics/annual').length");
    await js("document.querySelector('[data-action=filters-reset]').click()");
    await pause(250);
    assert.equal(await js("window.__calls.filter((c) => c.url === '/statistics/annual').length"), callsBeforeReset, '重置不自动请求');
    assert.equal(await js("document.querySelector('[data-nature-code=\"06\"]').checked"), false, '重置后空房 06 仍不勾选');
    assert.equal(await js("document.querySelector('[data-nature-code=\"05\"]').checked"), true);
    assert.equal(await js("document.querySelector('[data-fee-code=\"01\"]').checked"), true);
    assert.equal(await js("document.querySelector('[data-office-code=\"02\"]').checked"), true, '重置后管理处恢复全选');
    await js("document.querySelector('[data-testid=stats-submit]').click()");
    const resetQueryExpr = `(() => {
      const list = window.__calls.filter((c) => c.url === '/statistics/annual');
      const last = list[list.length - 1];
      return last && last.query.natures === '${expectedDefaultNatures}' && last.query.officeCodes.includes('02') && last.query.feeCodes.includes('01');
    })()`;
    await waitFor(resetQueryExpr, '重置后的年度请求');
    await waitFor("!!document.querySelector('.stats-annual-table')", '重置后年度表');
    await js('window.scrollTo(0, 0)');
    await pause(200);
    await screenshot('statistics-reset-default-1440.png');
  });
});

test('统计选项未就绪：优先显示后端 message，不渲染空表', { timeout: 60000 }, async () => {
  await withPage(async ({ js, waitFor, screenshot }) => {
    await waitFor("document.body.textContent.includes('MIS 镜像尚未完成首次同步')", '选项未就绪说明');
    assert.equal(await js("!!document.querySelector('.stats-annual-table')"), false, '选项未就绪时不能渲染年度表');
    assert.equal(await js("document.body.textContent.includes('当前筛选没有可汇总的数据')"), false, '未就绪时不能只说暂无数据');
    assert.ok(await js("[...document.querySelectorAll('button')].some((e) => e.textContent.trim() === '重试')"), '未就绪要有重试');
    await screenshot('statistics-options-unavailable.png');
  }, '?options-unavailable');
});
