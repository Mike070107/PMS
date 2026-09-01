import assert from 'node:assert/strict';
import test from 'node:test';
import { diffFields } from './ai-feedback.service';

test('相同文字只差标点空格不产生 AI 纠错', () => {
  assert.deepEqual(
    diffFields(
      { actionNote: '更换角阀；测试无渗漏' },
      { actionNote: '更换角阀，测试无渗漏。' },
    ),
    {},
  );
});

test('人工改过类型和说明时逐字段保留前后值', () => {
  assert.deepEqual(
    diffFields(
      { repairType: 'door_window', description: '门铃打不开门' },
      { repairType: 'smart', description: '门铃无响应，无法开门' },
    ),
    {
      repairType: { before: 'door_window', after: 'smart' },
      description: { before: '门铃打不开门', after: '门铃无响应，无法开门' },
    },
  );
});
