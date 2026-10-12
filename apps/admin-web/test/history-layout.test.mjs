import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const parking = readFileSync(new URL('../src/pages/ParkingManagementPage.css', import.meta.url), 'utf8');
const cashier = readFileSync(new URL('../src/pages/ApartmentCashierPage.css', import.meta.url), 'utf8');
test('人防不再展示独立续期卡片，授权后信息放在旧停车和PMS之间', () => {
  const source = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<DeliyunVehicleCard\b/);
  const compare = source.slice(source.indexOf('<div className={`parking-owner-compare'), source.indexOf('<ParkingMovementSection key={plate}'));
  assert.ok(compare.indexOf('parking-old-system-panels') < compare.indexOf('<CivilDefenseOwnerPanel'));
  assert.ok(compare.indexOf('<CivilDefenseOwnerPanel') < compare.indexOf('title="PMS系统业主信息"'));
  assert.match(compare, /deliyunVehicle\?\.civilDefenseAuthorized && <CivilDefenseOwnerPanel/);
  assert.match(compare, /parkingSpace=/); assert.match(compare, /validityRange=/);
  assert.match(parking, /\.parking-owner-compare.has-civil \{ grid-template-columns: repeat\(3,minmax\(0,1fr\)\)/);
});
test('人防授权日期使用确定格式，二期来源覆盖完整查询结果而非只有当前旧库行', () => {
  const source = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /\[row, \.\.\.\(operationRows \?\? \[\]\), \.\.\.rows\]/);
  assert.match(source, /beginDate: dayjs\(\).format\('YYYY-MM-DD'\)/);
  assert.doesNotMatch(source, /toLocaleDateString\('en-CA'/);
  assert.match(source, /civilCandidates.find\(candidate => parkingDatabase\(candidate.database\) === 'parking2'\)\s*\?\? civilCandidates.find\(candidate => parkingDatabase\(candidate.database\) === 'parking1'\)/);
  assert.match(source, /授权人防车库出现错误，没有读到车牌有效期/);
});
test('新增与换牌复用同一个点选车牌组件，不替换旧车牌输入', () => {
  const source = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /ParkingPlateEntry id="parking-change-plate-input" label="新车牌" value=\{newPlate\} onChange=\{setNewPlate\}/);
  assert.match(source, /ParkingPlateEntry id="parking-add-plate-input"/);
  assert.equal((source.match(/function ParkingPlateEntry\(/g) || []).length, 1);
  assert.match(source, /onChange\(normalized.slice\(0, -1\)\)/);
});
test('停车历史短字段不撑满整行，时间靠近操作类型', () => {
  assert.match(parking, /\.parking-history-list dl > div \{ flex: 0 1 auto; width: fit-content; max-width: 100%/);
  assert.match(parking, /\.parking-history-event-head \{[^}]*justify-content: flex-start/);
});
test('公寓收费历史按内容统一列宽，而非比例拉散', () => {
  assert.match(cashier, /grid-template-columns: repeat\(6,max-content\)/);
  assert.match(cashier, /grid-template-columns: subgrid/);
  assert.match(cashier, /overflow-x: auto/);
});

test('今日收费流水首列展示真实收费员，姓名明确为住户姓名，九列对齐', () => {
  const source = readFileSync(new URL('../src/pages/ApartmentCashierPage.tsx', import.meta.url), 'utf8');
  const today = source.slice(source.indexOf('<h2>今日收费流水</h2>'), source.indexOf('<aside className="cashier-checkout">'));
  assert.match(today, /cashier-history__head"><span>收费员<\/span><span>收费时间/);
  assert.match(today, /<span>住户姓名<\/span>/);
  assert.match(today, /<span>\{row.cashier \|\| '-'\}<\/span>/);
  assert.match(cashier, /\.cashier-today__table \{ grid-template-columns: repeat\(9,max-content\)/);
});
test('授权类型位于信息右侧，不独占一整行；保留手机单列', () => {
  assert.doesNotMatch(parking.match(/\.parking-vehicle-type \{[^}]+\}/)[0], /grid-column: 1 \/ -1/);
  assert.match(parking, /\.parking-query-card \{[^}]*216px minmax\(160px,200px\) minmax\(210px,280px\)/);
  assert.match(parking, /\.parking-query-card \{ grid-template-columns: minmax\(0,1fr\)/);
});
