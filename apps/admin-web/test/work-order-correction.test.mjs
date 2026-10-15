import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pages/WorkOrdersPage.tsx', import.meta.url), 'utf8');

test('工单详情故障描述旁有常驻更正入口，失败不清空用户输入', () => {
  assert.match(source, />更正描述<\/Button>/);
  assert.match(source, /url: `\/work-orders\/\$\{workOrderId\}\/description`/);
  assert.match(source, /setError\(e\?\.message \|\| '更正失败/);
  assert.doesNotMatch(source, /catch \(e: any\)[\s\S]{0,160}setContent\(''\)/);
});

test('指派人员随已选工种向后端请求实际规则候选人', () => {
  assert.match(source, /\.\.\.\(selectedSkill \? \{ skill: selectedSkill \} : \{\}\)/);
  assert.match(source, /\[open, communityId, selectedSkill, technicians\]/);
  assert.doesNotMatch(source, /technician\.skills\?\.includes\(selectedSkill\) \|\| selectedRule/);
});
