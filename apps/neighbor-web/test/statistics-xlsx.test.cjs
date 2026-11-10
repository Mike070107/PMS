// Production serializer, in-memory DOM fixtures + ZIP/XML assertions. No server or downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/lib/statistics-xlsx.ts');
const source = fs.readFileSync(filename, 'utf8');
function load(extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module, exports: module.exports, TextEncoder, Uint8Array, DataView, Blob, URL,
    setTimeout, ...extra,
  }, { filename });
  return module.exports;
}
const { serializeStatisticsXlsx } = load();

// Minimal standards-shaped DOM fixture; not a second workbook implementation.
// The browser integration suite owns real responsive layout and report-root selection.
class Element {
  constructor(tag, attrs, children) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.parentElement = null;
    this.childNodes = children.flat(Infinity).filter(x => x != null).map(child => {
      const node = typeof child === 'object' ? child : { nodeType: 3, textContent: String(child) };
      node.parentElement = this;
      return node;
    });
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  get className() { return this.attrs.class || ''; }
  get classList() { return { contains: value => this.className.split(/\s+/).includes(value) }; }
  get rowSpan() { return Number(this.attrs.rowspan ?? 1); }
  get colSpan() { return Number(this.attrs.colspan ?? 1); }
  get cells() { return this.children.filter(n => n.tagName === 'TD' || n.tagName === 'TH'); }
  get rows() {
    const walk = el => el.children.flatMap(n => n.tagName === 'TR' ? [n] : n.tagName === 'TABLE' ? [] : walk(n));
    return walk(this);
  }
  get caption() { return this.children.find(n => n.tagName === 'CAPTION') || null; }
  getAttribute(name) { return this.attrs[name] == null ? null : String(this.attrs[name]); }
  matches(selector) {
    return selector.split(',').some(raw => {
      const s = raw.trim();
      if (s.startsWith('.')) return this.classList.contains(s.slice(1));
      const attr = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attr) return attr[2] == null ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2];
      return this.tagName === s.toUpperCase();
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
const e = (tag, attrs = {}, ...children) => new Element(tag, attrs, children);
const th = (value, attrs = {}) => e('th', attrs, value);
const td = (value, attrs = {}) => e('td', attrs, value);
const tr = (...cells) => e('tr', {}, cells);
const table = (heads, rows, attrs = {}) => e('table', attrs, e('thead', {}, heads), e('tbody', {}, rows));
const metadata = { title: '当前报表 <&>', subtitle: '管理处：01；筛选：2026-01~2026-10', dataAsOf: '2026-11-10 12:00', note: '仅当前已加载结果，— 表示未知，不是零。' };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function unzip(bytes) {
  const buffer = Buffer.from(bytes);
  const files = {};
  const offsets = {};
  let pos = 0;
  while (buffer.readUInt32LE(pos) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(pos + 8), 0, 'ZIP STORE, not fake CSV');
    assert.equal(buffer.readUInt16LE(pos + 6), 0x800, 'UTF-8 flag');
    const size = buffer.readUInt32LE(pos + 18);
    assert.equal(buffer.readUInt32LE(pos + 22), size);
    const nameSize = buffer.readUInt16LE(pos + 26);
    const extra = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 30, pos + 30 + nameSize).toString('utf8');
    const begin = pos + 30 + nameSize + extra;
    const data = buffer.subarray(begin, begin + size);
    assert.equal(crc32(data), buffer.readUInt32LE(pos + 14), `${name} CRC32`);
    files[name] = data.toString('utf8');
    offsets[name] = pos;
    pos = begin + size;
  }
  const centralStart = pos;
  let count = 0;
  while (buffer.readUInt32LE(pos) === 0x02014b50) {
    const nameSize = buffer.readUInt16LE(pos + 28);
    const name = buffer.subarray(pos + 46, pos + 46 + nameSize).toString('utf8');
    assert.equal(buffer.readUInt32LE(pos + 42), offsets[name], 'central offset agrees');
    assert.equal(buffer.readUInt32LE(pos + 16), crc32(Buffer.from(files[name])));
    pos += 46 + nameSize + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
    count++;
  }
  assert.equal(buffer.readUInt32LE(pos), 0x06054b50);
  assert.equal(buffer.readUInt16LE(pos + 10), count);
  assert.equal(buffer.readUInt32LE(pos + 12), pos - centralStart);
  assert.equal(buffer.readUInt32LE(pos + 16), centralStart);
  assert.equal(pos + 22, buffer.length, 'no extra download payloads');
  return files;
}
function sheet(root, meta = metadata) { return unzip(serializeStatisticsXlsx(root, meta))['xl/worksheets/sheet1.xml']; }
function cells(xml) { return Array.from(xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g), m => ({ attrs: m[1], body: m[2] })); }
function cellWith(xml, text) { return cells(xml).find(cell => cell.body.includes(text)); }
function styleOf(cell) { return Number(cell.attrs.match(/\bs="(\d+)"/)[1]); }

function financialFixture() {
  return e('div', {},
    e('h2', {}, '当期明细'),
    table([
      tr(th('管理处编号', { rowspan: 2 }), th('经营指标', { colspan: 4 }), th('操作', { rowspan: 2 })),
      tr(th('净额（元）'), th('收缴率'), th('建筑面积'), th('票据张数')),
    ], [
      tr(td('0012'), td(e('button', { class: 'stats-money-btn' }, e('svg', {}, '图标'), '¥-1,234.50')), td('12.50%'), td('79.67 ㎡'), td('3')),
      tr(td('0000'), td('—'), td('—'), td('0.00 ㎡'), td('0'), td(e('button', {}, '查看'))),
      e('tr', { class: 'stats-subtotal-row stats-total-row' }, td(e('b', {}, '合计')), td('¥-1,234.50'), td('12.50%'), td('79.67 ㎡'), td('3'), td(e('button', {}, '导出'))),
    ]),
  );
}

test('valid single-sheet OOXML ZIP has theme, number formats, borders, bands, merged headers and metadata', () => {
  const files = unzip(serializeStatisticsXlsx(financialFixture(), metadata));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
  assert.equal((files['xl/workbook.xml'].match(/<sheet /g) || []).length, 1);
  assert.match(files['[Content_Types].xml'], /spreadsheetml\.sheet\.main\+xml/);
  assert.match(files['xl/_rels/workbook.xml.rels'], /Target="styles.xml"/);
  const styles = files['xl/styles.xml'];
  for (const value of ['FF164E63', 'FF0F766E', 'FFF0F9FA', 'FFCCFBF1', 'style="thin"', '0.00%', '¥', '㎡', '<b/>']) assert.ok(styles.includes(value), value);
  assert.match(styles, /numFmtId="164" formatCode="&quot;¥&quot;#,##0.00;\[Red\]-&quot;¥&quot;#,##0.00"/);
  const xml = files['xl/worksheets/sheet1.xml'];
  for (const value of ['当前报表 &lt;&amp;&gt;', metadata.subtitle, metadata.dataAsOf, '当期明细', '未知，不是零']) assert.ok(xml.includes(value));
  assert.match(xml, /<pane xSplit="1" ySplit="8" topLeftCell="B9"[^>]+state="frozen"/);
  assert.match(xml, /<col min="1" max="1" width="\d+" customWidth="1"/);
  assert.match(xml, /<mergeCell ref="A7:A8"\/>/);
  assert.match(xml, /<mergeCell ref="B7:E7"\/>/);
  assert.match(xml, /<mergeCell ref="A1:E1"\/>/);
  assert.ok(!xml.includes('图标') && !xml.includes('查看') && !xml.includes('操作') && !xml.includes('导出'));
  assert.equal(styleOf(cellWith(xml, '0012')), 6, 'first body row');
  assert.equal(styleOf(cellWith(xml, '0000')), 11, 'alternate body row');
  assert.equal(styleOf(cellWith(xml, '<t xml:space="preserve">合计</t>')), 16, 'total row has bold/shaded style');
});

test('yuan negatives, percentages, areas and counts remain numeric; unknown and identifiers do not become zero', () => {
  const xml = sheet(financialFixture());
  const money = cellWith(xml, '<v>-1234.5</v>');
  assert.ok(money);
  assert.doesNotMatch(money.attrs, /inlineStr/);
  assert.equal(styleOf(money), 8);
  assert.equal(styleOf(cellWith(xml, '<v>0.125</v>')), 9);
  assert.equal(styleOf(cellWith(xml, '<v>79.67</v>')), 10);
  assert.equal(styleOf(cellWith(xml, '<v>3</v>')), 7);
  for (const value of ['0012', '0000', '—']) assert.match(cellWith(xml, `<t xml:space="preserve">${value}</t>`).attrs, /t="inlineStr"/);
  assert.equal((xml.match(/<t xml:space="preserve">—<\/t>/g) || []).length, 2);
  assert.ok(cellWith(xml, '<v>0</v>'), 'genuine zero is still numeric');
});

test('formula-like text is safe inline data, including identifiers, large integers and negative nonnumbers', () => {
  const inputs = ['=SUM(A1:A2)', '+SUM(A1:A2)', '@evil', '-1+2', '000123', '123456789012345678', '<tag>&"\u0001'];
  const root = e('div', {}, table([tr(th('金额'), th('票据编号'), th('电话'))], inputs.map(value => tr(td(value, { class: 'num' }), td(value), td('13800138000')))));
  const xml = sheet(root);
  assert.doesNotMatch(xml, /<f(?:\s|>)/);
  for (const value of inputs.slice(0, -1)) assert.match(cellWith(xml, `<t xml:space="preserve">${value}</t>`).attrs, /t="inlineStr"/);
  assert.match(cellWith(xml, '13800138000').attrs, /t="inlineStr"/);
  assert.ok(xml.includes('&lt;tag&gt;&amp;&quot;') && !xml.includes('\u0001'));
});

test('multiple current report tables and section titles share one sheet; hidden annual table retained, cards ignored', () => {
  const current = e('section', {},
    e('div', { style: 'display:none', 'aria-hidden': 'true' },
      table([tr(th('编号'), th('2026'), th('合计'))], [tr(td('01'), td(e('button', { class: 'stats-money-btn' }, '¥10.00')), td('¥10.00'))], { class: 'stats-annual-table' })),
    e('div', { class: 'stats-mobile-cards' }, e('h3', {}, 'DUPLICATE MOBILE CARD'), '¥10.00'),
    e('section', {}, e('div', { class: 'panelHd' }, e('b', {}, '票据口径'), e('button', {}, '刷新')),
      table([tr(th('票据编号'), th('金额'))], [tr(td(e('button', { class: 'stats-money-btn stats-cell-link' }, '00042 · 明细')), td('¥20.00'))])),
    e('section', {}, e('h3', {}, '其中：按收款人'), table([tr(th('收款人'), th('金额'))], [tr(td('张三'), td('¥30.00'))])),
    e('section', { 'data-xlsx-ignore': '' }, table([tr(th('OTHER'))], [tr(td('NOT CURRENT'))])),
  );
  // A neighbouring report exists in the page but is not inside the supplied root.
  e('main', {}, current, table([tr(th('OUTSIDE'))], [tr(td('OTHER REPORT'))]));
  const xml = sheet(current);
  for (const value of ['票据口径', '其中：按收款人', '张三', '00042', '<v>10</v>', '<v>20</v>', '<v>30</v>']) assert.ok(xml.includes(value), value);
  for (const value of ['DUPLICATE MOBILE CARD', 'NOT CURRENT', 'OTHER REPORT', '刷新', '· 明细']) assert.ok(!xml.includes(value), value);
  assert.equal((xml.match(/<v>10<\/v>/g) || []).length, 2, 'annual row and its total, not mobile duplicates');
});

test('semantic formats handle unprefixed money, parentheses, body rowspan and data hints without guessing arbitrary text', () => {
  const root = table([tr(th('名称'), th('应收'), th('面积'), th('张数'), th('备注'))], [
    tr(td('甲', { rowspan: 2 }), td('(1,234.00)'), td('100.25'), td('12'), td('123')),
    tr(td('-¥2,000.50'), td('—'), td('0'), td('001', { 'data-xlsx-type': 'text' })),
  ]);
  const xml = sheet(root, { title: '负数/测试' });
  assert.match(xml, /<v>-1234<\/v>/);
  assert.match(xml, /<v>-2000.5<\/v>/);
  assert.match(xml, /<v>100.25<\/v>/);
  assert.match(cellWith(xml, '<t xml:space="preserve">123</t>').attrs, /inlineStr/);
  assert.match(cellWith(xml, '<t xml:space="preserve">001</t>').attrs, /inlineStr/);
  assert.match(xml, /<mergeCell ref="A5:A6"\/>/);
  assert.ok(xml.includes('数据截至：未提供'));
  assert.ok(unzip(serializeStatisticsXlsx(root, { title: '负数/测试' }))['xl/workbook.xml'].includes('name="负数 测试"'));
});

test('count semantics outrank financial parent labels; numeric-looking names and UI labels stay strings', () => {
  const xml = sheet(table([tr(th('收款人'), th('收款笔数'), th('收款方式'), th('金额'), th('备注'))], [
    tr(td('123'), td('12'), td('010'), td('0.00'), td(e('button', { 'aria-label': '查看' }, '查看'))),
  ]));
  assert.match(cellWith(xml, '<t xml:space="preserve">123</t>').attrs, /inlineStr/);
  assert.match(cellWith(xml, '<t xml:space="preserve">010</t>').attrs, /inlineStr/);
  assert.equal(styleOf(cellWith(xml, '<v>12</v>')), 7, 'count, not yuan');
  assert.equal(styleOf(cellWith(xml, '<v>0</v>')), 8, 'known zero yuan');
  assert.ok(!xml.includes('查看'));
});

test('rowspan zero spans its row group and header merges survive removal of action columns', () => {
  const root = table([
    tr(th('分组', { rowspan: 0 }), th('财务', { colspan: 3 })),
    tr(th('金额'), th('查看'), th('票据张数')),
  ], [tr(td('A'), td('¥5.00'), td(e('button', {}, '查看')), td('2'))]);
  const xml = sheet(root, { title: '跨度' });
  assert.match(xml, /<mergeCell ref="A4:A5"\/>/);
  assert.match(xml, /<mergeCell ref="B4:C4"\/>/);
  assert.match(xml, /<c r="C6"[^>]*><v>2<\/v>/);
  assert.ok(!xml.includes('查看'));
});

test('empty current results fail before any download is prepared', () => {
  assert.throws(() => serializeStatisticsXlsx(e('div', {}, '没有结果'), metadata), /没有可导出的表格/);
});

test('download wrapper creates one workbook and clicks one anchor; all download facilities are inert stubs', async () => {
  const root = financialFixture();
  const calls = { created: 0, clicked: 0, removed: 0, appended: 0, revoked: 0 };
  let blob;
  let deferred;
  const anchor = { style: {}, click() { calls.clicked++; }, remove() { calls.removed++; } };
  root.ownerDocument = {
    defaultView: { URL: {
      createObjectURL(value) { calls.created++; blob = value; return 'blob:unit-test-only'; },
      revokeObjectURL(url) { assert.equal(url, 'blob:unit-test-only'); calls.revoked++; },
    } },
    createElement(tag) { assert.equal(tag, 'a'); return anchor; },
    body: { appendChild(value) { assert.equal(value, anchor); calls.appended++; } },
  };
  const { downloadStatisticsXlsx } = load({ setTimeout(fn) { deferred = fn; } });
  await downloadStatisticsXlsx(root, { ...metadata, title: '当前/报表.xlsx' });
  assert.deepEqual(calls, { created: 1, clicked: 1, removed: 1, appended: 1, revoked: 0 });
  assert.equal(anchor.download, '当前_报表.xlsx');
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  unzip(new Uint8Array(await blob.arrayBuffer()));
  deferred();
  assert.equal(calls.revoked, 1);
});

test('long filter metadata wraps with sufficient row height and separate filter lines', () => {
  const longFilter = `管理处：${'枫桦景苑二期、'.repeat(24)}`;
  const xml = sheet(financialFixture(), { ...metadata, subtitle: `${longFilter}\n关键词：当前条件` });
  assert.ok(Number(xml.match(/<row r="2" ht="([\d.]+)"/)[1]) > 32);
  assert.ok(xml.includes(longFilter) && xml.includes('关键词：当前条件'));
  assert.equal(cells(xml).filter(cell => cell.body.includes('关键词：当前条件')).length, 1);
});

test('helper typechecks against the app ES2020 + DOM contract, without building the application', () => {
  const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, strict: true, noEmit: true, skipLibCheck: true, lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] };
  const program = ts.createProgram([filename], options);
  const errors = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: f => f, getCurrentDirectory: () => __dirname, getNewLine: () => '\n' }));
});
