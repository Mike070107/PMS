import assert from 'node:assert/strict';
import test from 'node:test';
import { AiToolsController } from './ai-tools.controller';
import {
  matchRepairTypeKeywords,
  RepairTextAiService,
  validateCompletionFeeRule,
} from './repair-text.ai';

test('完工语音中的材料只作提醒，接口不得返回自动加料候选', async () => {
  const controller = new AiToolsController(
    {
      summarizeCompletion: async () => ({
        actionNote: '检查并更换继电器',
        faultLocation: '控制箱',
        faultSymptom: '继电器接触不良',
        materials: [{ name: '继电器', qty: 1, unit: '只' }],
        feeRuleCode: '',
      }),
    } as any,
    { list: async () => [] } as any,
    {} as any,
  );

  const result = await controller.completionSummary(
    { text: '换了一个继电器' },
    { id: 7, tenantId: 1 } as any,
  );

  assert.deepEqual(result.materials, ['继电器']);
  assert.equal('materialSuggestions' in result, false);
  assert.deepEqual(result.draft.materials, ['继电器']);
});

test('收费必须同时命中已有规则编码和适用词', () => {
  const rules = [
    { code: 'replace_valve', name: '更换角阀', feeCents: 5000, keywords: ['更换角阀', '换角阀'] },
  ];
  assert.equal(
    validateCompletionFeeRule('replace_valve', rules, '已更换角阀并测试无渗漏')?.feeCents,
    5000,
  );
  assert.equal(validateCompletionFeeRule('replace_valve', rules, '只是紧固接头'), null);
  assert.equal(validateCompletionFeeRule('replace_valve', rules, '免费更换角阀'), null);
});

test('报修 AI 先采用“猜你想输”明确配置的关键词', async () => {
  let prompt = '';
  const service = new RepairTextAiService(
    {
      askJson: async (_tenantId: number, system: string) => {
        prompt = system;
        // 模拟模型仍误判成门窗；服务端必须用明确关键词结果覆盖它。
        return { repairType: 'door_window', description: '家里门铃打不开门' };
      },
    } as any,
    { findExact: async () => null, forPrompt: async () => [] } as any,
  );
  const types = [
    {
      repairType: 'smart',
      label: '智能化相关',
      configuredKeywords: ['门铃'],
      keywords: ['门铃', '门禁', '对讲'],
    },
    {
      repairType: 'door_window',
      label: '门锁门窗相关',
      configuredKeywords: ['门锁'],
      keywords: ['门锁', '打不开门'],
    },
  ];
  const result = await service.parse(1, '枫桦景苑二期25号303家里门铃打不开门', types);
  assert.equal(result?.repairType, 'smart');
  assert.match(prompt, /猜你想输/);
  assert.match(prompt, /系统已先按物业配置关键词明确命中：smart/);
  assert.doesNotMatch(prompt, /__SMART_TYPE__/);
});

test('完全相同的原话直接采用样例，不再交给模型二次猜测', async () => {
  let llmCalled = false;
  const service = new RepairTextAiService(
    {
      askJson: async () => {
        llmCalled = true;
        return { repairType: 'door_window', publicArea: false };
      },
    } as any,
    {
      findExact: async () => ({
        expected: {
          repairType: 'menjing',
          addressText: '枫桦二期2号 公共区域',
          contactName: '228/2/802',
          description: '门铃开不了楼下门',
        },
      }),
      forPrompt: async () => [],
    } as any,
  );
  const result = await service.parse(1, '枫桦二期2号802门铃开不了楼下门', [
    { repairType: 'menjing', label: '智能化相关', configuredKeywords: ['门铃'] },
    { repairType: 'door_window', label: '门锁门窗相关' },
  ]);
  assert.equal(llmCalled, false);
  assert.equal(result?.repairType, 'menjing');
  assert.equal(result?.publicArea, true);
  assert.equal(result?.description, '门铃开不了楼下门');
  assert.equal(result?.sampleMatched, true);
  // 房号不是人名；后续按这一次真正撞到的地址动态生成，避免其它地址复制 228/2/802。
  assert.equal(result?.contactName, '');
});

test('明确配置词优先于系统辅助关键词', () => {
  assert.equal(
    matchRepairTypeKeywords('家里门铃打不开门', [
      { repairType: 'smart', label: '智能化', configuredKeywords: ['门铃'], keywords: [] },
      { repairType: 'door', label: '门窗', configuredKeywords: [], keywords: ['打不开门'] },
    ]),
    'smart',
  );
});
