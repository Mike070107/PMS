import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/pages/PropertiesPage.tsx', import.meta.url),
  'utf8',
);

test('小区树标题只显示小区名称和户数，不把地址弄号拼入名称', () => {
  const titleLine = source
    .split('\n')
    .find((line) => line.includes('title: `${shortPhaseName(community.name, parentName)}'));

  assert.ok(titleLine, '应找到小区树标题实现');
  assert.doesNotMatch(titleLine, /mainLane|弄/);
  assert.match(titleLine, /\$\{houseCount\}/);
});
