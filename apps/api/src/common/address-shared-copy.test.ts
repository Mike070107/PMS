import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('API 的地址匹配副本与 shared-types 完全一致', () => {
  const copy = readFileSync(join(__dirname, 'address.shared.ts'), 'utf8').replace(/\r\n/g, '\n');
  const origin = readFileSync(join(__dirname, '../../../../packages/shared-types/src/address.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(copy.slice(copy.indexOf('\n') + 1), origin, '改了 packages/shared-types/src/address.ts 后要重新复制到 apps/api/src/common/address.shared.ts');
});
