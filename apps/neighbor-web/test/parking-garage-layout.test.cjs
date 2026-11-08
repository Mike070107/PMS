// 车位 2.5D 示意图布局：纯函数回归（不连库、不起浏览器）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadLayoutModule() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'parking-garage-layout.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require });
  return mod.exports;
}

const layout = loadLayoutModule();
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, spaceNo: String(i + 1) }));

test('车位号按自然顺序排：1、2、10 不是 1、10、2', () => {
  assert.equal(['10', '2', '1', 'B2', 'A1'].sort(layout.naturalCompare).join(','), '1,2,10,A1,B2');
  const rows = [
    { id: 3, spaceNo: '10' },
    { id: 1, spaceNo: '2' },
    { id: 2, spaceNo: '1' },
  ];
  const out = layout.layoutGarage(rows);
  assert.equal(out.cells.map((c) => c.row.spaceNo).join(','), '1,2,10');
});

test('大车库 182 个车位：双排布局、每排 27、7 排、3 条车道', () => {
  const out = layout.layoutGarage(makeRows(182));
  assert.equal(out.cells.length, 182);
  assert.equal(out.perRow, 27);
  assert.equal(out.rowCount, 7);
  assert.equal(out.aisles.length, 3);
  assert.equal(out.width, 27 * layout.BAY_W);
  assert.equal(out.depth, 53);
  const ids = new Set(out.cells.map((c) => c.row.id));
  assert.equal(ids.size, 182, '每个车位只能出现一次');
  assert.ok(out.cells.every((c) => Math.abs(c.x) <= out.width / 2 + 0.001), 'x 必须在车库宽度内');
  assert.ok(out.cells.every((c) => Math.abs(c.z) <= out.depth / 2 + 0.001), 'z 必须在车库进深内');
  // 第一排和最后一排的 z 必须落在地块边界内
  const zs = out.cells.map((c) => c.z);
  assert.ok(Math.min(...zs) >= -out.depth / 2 - 0.001);
  assert.ok(Math.max(...zs) <= out.depth / 2 + 0.001);
});

test('人防车库 94 个车位：每排 19、5 排、最后一排为余数', () => {
  const out = layout.layoutGarage(makeRows(94));
  assert.equal(out.perRow, 19);
  assert.equal(out.rowCount, 5);
  assert.equal(out.cells.filter((c) => c.rowIndex === 4).length, 94 - 19 * 4);
  assert.equal(out.aisles.length, 2);
});

test('窄屏可指定每排车位数（排得更竖，车位块更大）', () => {
  const out = layout.layoutGarage(makeRows(182), { perRow: 20 });
  assert.equal(out.perRow, 20);
  assert.equal(out.rowCount, 10);
  assert.equal(out.cells.filter((c) => c.rowIndex === 9).length, 2);
  assert.ok(out.depth > out.width, '窄屏布局应比横屏更竖');
});

test('空列表不炸：布局为空、尺寸为 0', () => {
  const out = layout.layoutGarage([]);
  assert.equal(out.cells.length, 0);
  assert.equal(out.rowCount, 0);
  assert.equal(out.width, 0);
  assert.equal(out.depth, 0);
});

test('车位状态：空位、已绑、7 天内到期、已过期', () => {
  const today = new Date(2026, 10, 8); // 2026-11-08
  assert.equal(layout.spaceStatus({ plate: null, endDate: '2026-12-31' }, today), 'free');
  assert.equal(layout.spaceStatus({ plate: '  ', endDate: '2026-12-31' }, today), 'free');
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: null }, today), 'bound');
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: '2026-11-20' }, today), 'bound');
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: '2026-11-15' }, today), 'expiring');
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: '2026-11-08' }, today), 'expiring');
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: '2026-11-07' }, today), 'expired');
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: '2026-11-01T00:00:00.000Z' }, today), 'expired');
});

test('日期只认自然日：非法值按「未登记到期」处理，不冒充过期', () => {
  assert.equal(layout.parseSpaceDate(null), null);
  assert.equal(layout.parseSpaceDate(''), null);
  assert.equal(layout.parseSpaceDate('待定'), null);
  assert.equal(layout.spaceStatus({ plate: '沪A12345', endDate: '待定' }, new Date(2026, 10, 8)), 'bound');
  assert.equal(layout.parseSpaceDate('2026-02-31'), new Date(2026, 2, 3).getTime());
});
