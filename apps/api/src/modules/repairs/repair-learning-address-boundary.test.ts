import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairsService } from './repairs.service';
import { ExtractSamplesService } from '../ai/extract-samples.service';
import { RepairTextAiService } from '../ai/repair-text.ai';

const types = [
  { repairType: 'intercom', label: '智能化', keywords: ['话机'] },
  { repairType: 'electric', label: '电气', keywords: ['插座'] },
];

// 只隔离数据库/模型/地址撞库，保留真实parse、样例作用域和类别覆盖逻辑。
function fixture() {
  let id = 1;
  const rows: any[] = [];
  function matches(row: any, where: any) {
    return Object.entries(where || {}).every(([key, value]: [string, any]) => {
      if (value?._type === 'in') return value._value.includes(row[key]);
      if (value?._type === 'raw') {
        return row.expected?._officeId === undefined
          || row.expected?._officeId === value._objectLiteralParameters.sampleOfficeId;
      }
      return row[key] === value;
    });
  }
  const repo: any = {
    create: (row: any) => ({ ...row }),
    count: async ({ where }: any) => rows.filter(row => matches(row, where)).length,
    find: async ({ where, take }: any = {}) => rows.filter(row => matches(row, where))
      .sort((a, b) => b.id - a.id).slice(0, take || 10000),
    findOne: async ({ where }: any) => rows.find(row => matches(row, where)),
    save: async (input: any): Promise<any> => {
      if (Array.isArray(input)) return Promise.all(input.map(row => repo.save(row)));
      const row = { ...input, id: input.id || id++, updatedAt: new Date() };
      const index = rows.findIndex(value => value.id === row.id);
      if (index < 0) rows.push(row); else rows[index] = row;
      return row;
    },
    remove: async (row: any) => {
      const index = rows.findIndex(value => value.id === row.id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
  const samples = new ExtractSamplesService(repo);
  const service: any = Object.create(RepairsService.prototype);
  service.resolveTenantId = () => 7;
  service.listPublicRepairTypes = async () => types;
  service.accessService = { officeIdOfCommunity: async (_tenant: number, community: number) => community === 100 ? 10 : 20 };
  service.parseAddressByRule = async () => ({ matched: true, level: 'house', communityId: 200,
    roomNo: '201', addressText: 'B小区10号201室', matchedRaw: 'B小区10号201' });
  service.findTypeRule = async (type: string) => types.find(row => row.repairType === type);
  service.logger = { warn: () => {} };
  service.extractSamples = samples;
  service.repairTextAi = new RepairTextAiService({ askJson: async () => ({ repairType: 'intercom', description: '家里话机没信号' }) } as any, samples);
  return { service, samples };
}

test('最终地址是office B时不得保留context office A分类样例', async () => {
  const { service, samples } = fixture();
  await samples.rememberRepairType(7, 8, 10, 1, '家里话机没信号', 'electric');
  const result = await service.parseRepairAddress({ text: '家里话机没信号', communityId: 100 }, { id: 8, tenantId: 7 });
  assert.equal(result.communityId, 200);
  assert.equal(result.ai.repairType, 'intercom', 'B没有electric样例，不沿用A学习覆盖');
});

test('lite规则撞到房号时，带门牌同类报修仍使用本office学习', async () => {
  const { service, samples } = fixture();
  await samples.rememberRepairType(7, 8, 20, 1, '家里话机没信号', 'electric');
  const result = await service.parseRepairAddress({ text: 'B小区10号201家里话机没信号', communityId: 200, lite: true }, { id: 8, tenantId: 7 });
  assert.equal(result.ai?.repairType, 'electric', '去掉可信门牌后使用本处人工确认，不绕过学习');
});

test('AI地址重试跨office后，类别重判异常清除旧scope类别并保留地址描述', async () => {
  const { service } = fixture();
  let parses = 0, addresses = 0;
  service.parseAddressByRule = async () => ++addresses === 1
    ? { matched: true, level: 'community', communityId: 100, addressText: 'A小区' }
    : { matched: true, level: 'house', communityId: 200, addressText: 'B小区10号201室', roomNo: '201', matchedRaw: 'B小区10号201' };
  service.repairTextAi = { parse: async () => {
    if (++parses === 1) return { repairType: 'electric', sampleMatched: true, addressText: 'B小区10号201', description: '家里话机没信号' };
    throw new Error('temporary model failure');
  } };
  const result = await service.parseRepairAddress({ text: 'B小区10号201家里话机没信号', communityId: 100 }, { id: 8, tenantId: 7 });
  assert.equal(result.communityId, 200);
  assert.equal(result.addressText, 'B小区10号201室');
  assert.equal(result.ai.repairType, '', '重判失败不能保留A scope类别');
  assert.equal(result.ai.sampleMatched, false);
  assert.equal(result.ai.description, '家里话机没信号');
});

test('无office不读取office学习，另租户同句不读取', async () => {
  const { samples } = fixture();
  await samples.rememberRepairType(7, 8, 10, 1, '家里话机没信号', 'electric');
  assert.equal(await samples.findExact(7, '家里话机没信号', 'repair', null), null);
  assert.equal(await samples.findExact(8, '家里话机没信号', 'repair', 10), null);
});
