import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchCompletionMaterials,
  matchRepairTypeKeywords,
  RepairTextAiService,
  validateCompletionFeeRule,
} from './repair-text.ai';

const catalog = [
  { id: 1, name: '不锈钢角阀', spec: 'DN15', unit: '只', aliases: ['角阀'] },
  { id: 2, name: '生料带', unit: '卷', aliases: ['密封带'] },
  { id: 3, name: 'PVC弯头', spec: '20mm', unit: '个', aliases: ['弯头'] },
  { id: 4, name: 'PPR弯头', spec: '20mm', unit: '个', aliases: ['弯头'] },
];

test('材料口语名唯一命中别名且数量明确时可形成草稿候选', () => {
  const [row] = matchCompletionMaterials([{ name: '角阀', qty: 1, unit: '只' }], catalog);
  assert.equal(row.materialId, 1);
  assert.equal(row.match, 'exact');
  assert.equal(row.needsConfirmation, false);
});

test('同一别名对应多个 SKU 时必须人工选择', () => {
  const [row] = matchCompletionMaterials([{ name: '弯头', qty: 1, unit: '个' }], catalog);
  assert.equal(row.match, 'candidate');
  assert.equal(row.needsConfirmation, true);
});

test('没说数量时即便 SKU 唯一也不能自动补数量', () => {
  const [row] = matchCompletionMaterials([{ name: '生料带', qty: null, unit: '' }], catalog);
  assert.equal(row.match, 'exact');
  assert.equal(row.needsConfirmation, true);
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
    { forPrompt: async () => [] } as any,
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

test('明确配置词优先于系统辅助关键词', () => {
  assert.equal(
    matchRepairTypeKeywords('家里门铃打不开门', [
      { repairType: 'smart', label: '智能化', configuredKeywords: ['门铃'], keywords: [] },
      { repairType: 'door', label: '门窗', configuredKeywords: [], keywords: ['打不开门'] },
    ]),
    'smart',
  );
});
