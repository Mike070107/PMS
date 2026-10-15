import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkOrderStatus } from '../../common/enums';
import { RepairsService } from './repairs.service';

test('更正故障描述保留原话、写工单日志并记录 AI 三联纠错', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  const workOrder = { id: 134, tenantId: 1, requestId: 134, communityId: 2, status: WorkOrderStatus.CREATED };
  const request = {
    id: 134,
    tenantId: 1,
    content: '19号702权限编号11269和11270',
    originalContent: '228弄23号201 IC卡开通两期19号702权限编号11269和11270',
    addressText: '枫桦景苑二期23号201室',
    contactName: '刘薇薇',
    contactPhone: '',
    repairType: 'menjing',
    urgent: false,
    houseId: 970,
  };
  const saved: unknown[] = [];
  const logs: unknown[][] = [];
  let feedback: any;
  service.resolveTenantId = () => 1;
  service.assertWorkOrderScope = () => undefined;
  service.workOrderRepo = { findOne: async () => workOrder };
  service.repairRequestRepo = { findOne: async () => request };
  service.dataSource = {
    transaction: async (fn: (manager: any) => Promise<void>) => fn({ save: async (_entity: unknown, row: unknown) => saved.push(row) }),
  };
  service.writeLog = async (...args: unknown[]) => logs.push(args);
  service.settings = { getAiAssistRaw: async () => ({ model: 'test-model' }) };
  service.aiFeedback = { record: async (_tenantId: number, input: unknown) => { feedback = input; return { id: 1 }; } };
  service.logger = { warn: () => undefined };

  const content = 'IC卡11269、11270需开通枫桦景苑二期19号702室门禁权限';
  const result = await service.updateWorkOrderDescription(
    134,
    { content, reason: 'AI 遗漏关键业务信息' },
    { id: 9, tenantId: 1 },
  );

  assert.equal(request.content, content);
  assert.equal(saved.length, 2);
  assert.equal(logs[0][3], 'change_description');
  assert.equal(feedback.sourceText, request.originalContent);
  assert.equal(feedback.draft.description, '19号702权限编号11269和11270');
  assert.equal(feedback.finalValue.description, content);
  assert.equal(feedback.finalValue.repairType, 'menjing');
  assert.equal(result.learningRecorded, true);
});

test('更正业务写入失败时不写 AI 学习记录', async () => {
  const service = Object.create(RepairsService.prototype) as any;
  let learned = false;
  service.resolveTenantId = () => 1;
  service.assertWorkOrderScope = () => undefined;
  service.workOrderRepo = { findOne: async () => ({ id: 1, tenantId: 1, requestId: 1, communityId: 2, status: WorkOrderStatus.CREATED }) };
  service.repairRequestRepo = { findOne: async () => ({ id: 1, content: '旧描述', originalContent: '原话', houseId: 1 }) };
  service.dataSource = { transaction: async () => { throw new Error('数据库写入失败'); } };
  service.aiFeedback = { record: async () => { learned = true; } };

  await assert.rejects(
    service.updateWorkOrderDescription(1, { content: '新描述' }, { id: 9, tenantId: 1 }),
    /数据库写入失败/,
  );
  assert.equal(learned, false);
});
