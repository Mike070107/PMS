import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const parking = readFileSync(new URL('../src/pages/ParkingManagementPage.css', import.meta.url), 'utf8');
const cashier = readFileSync(new URL('../src/pages/ApartmentCashierPage.css', import.meta.url), 'utf8');
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
test('授权类型位于信息右侧，不独占一整行；保留手机单列', () => {
  assert.doesNotMatch(parking.match(/\.parking-vehicle-type \{[^}]+\}/)[0], /grid-column: 1 \/ -1/);
  assert.match(parking, /\.parking-query-card \{[^}]*216px minmax\(160px,200px\) minmax\(210px,280px\)/);
  assert.match(parking, /\.parking-query-card \{ grid-template-columns: minmax\(0,1fr\)/);
});
