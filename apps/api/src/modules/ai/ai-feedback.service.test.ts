import assert from 'node:assert/strict';
import test from 'node:test';
import { consistentCorrectionKey, diffFields } from './ai-feedback.service';
import { buildLearningTemplate, learningSimilarity } from './extract-samples.service';

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

test('同一句原话、同一最终结果忽略标点和字段顺序，可累计为一致纠错', () => {
  const a = consistentCorrectionKey('18号802可视对讲，没有图像', 'repair', {
    addressText: '枫桦景苑二期18号802室',
    publicArea: false,
    description: '可视对讲没有图像',
  });
  const b = consistentCorrectionKey('18号802可视对讲 没有图像。', 'repair', {
    description: '可视对讲，没有图像。',
    publicArea: false,
    addressText: '枫桦景苑二期18号802室',
  });
  assert.equal(a, b);
});

test('人工最终地址或区域不同视为冲突纠错，不得自动学习', () => {
  const indoor = consistentCorrectionKey('18号802可视对讲没有图像', 'repair', {
    addressText: '枫桦景苑二期18号802室', publicArea: false,
  });
  const publicArea = consistentCorrectionKey('18号802可视对讲没有图像', 'repair', {
    addressText: '枫桦景苑二期18号公共区域', publicArea: true,
  });
  assert.notEqual(indoor, publicArea);
});

test('学习模板忽略房号和具体编号，保留业务结构', () => {
  assert.equal(
    buildLearningTemplate('228弄23号201 IC卡开通两期19号702权限编号11269和11270'),
    buildLearningTemplate('198弄8号502 IC卡开通一期6号301权限编号99881和99882'),
  );
  assert.equal(
    buildLearningTemplate('枫桦景苑二期18号802可视对讲没有图像'),
    buildLearningTemplate('枫桦景苑二期25号303可视对讲没有图像'),
  );
});

test('相似故障可召回，完全不同业务不会误当同类', () => {
  const learned = buildLearningTemplate('18号802可视对讲没有图像');
  assert.ok(learningSimilarity(learned, buildLearningTemplate('25号303可视对讲没有声音')) > 0.28);
  assert.ok(learningSimilarity(learned, buildLearningTemplate('3号楼道水管爆裂')) < 0.28);
});
