import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parkingRenewalEndDate } from '../src/lib/parkingRenewal.ts';

for (const [current, months, expected] of [
  ['2026-09-30', 1, '2026-10-31'],
  ['2026-10-31', 1, '2026-11-30'],
  ['2027-01-31', 1, '2027-02-28'],
  ['2028-01-31', 1, '2028-02-29'],
  ['2027-02-28', 1, '2027-03-31'],
  ['2026-12-31', 2, '2027-02-28'],
  ['2026-09-30', 3, '2026-12-31'],
  ['2026-09-30', 6, '2027-03-31'],
  ['2028-02-29', 12, '2029-02-28'],
  ['2026-09-15', 1, '2026-10-31'],
]) {
  test(`${current} 续期 ${months} 个月到目标月末 ${expected}`, () => {
    assert.equal(parkingRenewalEndDate(current, months), expected);
  });
}

test('缺失/无效日期或期限不生成到期日', () => {
  for (const date of ['', 'not-a-date']) assert.equal(parkingRenewalEndDate(date, 1), '');
  for (const months of [0, -1, 1.5, NaN, Infinity]) assert.equal(parkingRenewalEndDate('2026-09-30', months), '');
});

test('正式页默认期限、切换期限和预览续期共用规则，提交保留手选日期', () => {
  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  const preview = readFileSync(new URL('../src/pages/ParkingManagementPreviewPage.tsx', import.meta.url), 'utf8');
  assert.ok(/import \{ parkingRenewalEndDate \} from '\.\.\/lib\/parkingRenewal'/.test(page), '正式页必须引用共享计算');
  assert.ok(/parkingRenewalEndDate\(currentEndDate, 1\)/.test(page), '打开弹窗即计算默认一个月');
  assert.ok(/parkingRenewalEndDate\(previousEndDate, value\)/.test(page), '切换期限必须从原到期日计算');
  assert.ok(/parkingRenewalEndDate\(vehicle\.validUntil, months\)/.test(preview), '预览与正式续期规则一致');
  assert.ok(/endDate, previousEndDate, identity, amount: calculatedAmount, months/.test(page), '提交使用当前所选日期');
});

test('同车牌跨一期二期时建立两个续期任务，资料复用不携带到期日', () => {
  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /onOperation\('renew_vehicle', row, parkingRenewalTargets\(group\)\)/);
  assert.match(page, /Promise\.all\(targets\.map/);
  assert.doesNotMatch(page, /message=\{`将覆盖\$\{targetLabel\}的房号、车牌到期日和备注`\}/);
  assert.match(page, /车牌到期日不会被复用或修改/);
});
