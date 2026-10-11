import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const parking = readFileSync(new URL('../src/pages/ParkingManagementPage.css', import.meta.url), 'utf8');
const cashier = readFileSync(new URL('../src/pages/ApartmentCashierPage.css', import.meta.url), 'utf8');
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
