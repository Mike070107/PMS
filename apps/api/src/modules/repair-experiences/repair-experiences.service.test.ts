import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairExperiencesService } from './repair-experiences.service';

const accessBase = {
  isPlatformAdmin: false, isTenantAdmin: false, pages: {}, scopeAll: false,
  communityIds: [], enabledPages: null, roleIds: [], actingOfficeId: null,
};

test('默认维修工只自动进入自己管理处和类别对应的共享笔记本', async () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  service.ruleRepo = { async find() { return [
    { officeId: 1, repairType: 'electric', label: '电气', assigneeId: null, assigneeIds: [7], enabled: true },
    { officeId: 1, repairType: 'plumbing', label: '管道', assigneeId: 8, assigneeIds: [], enabled: true },
    { officeId: 2, repairType: 'access', label: '智能化', assigneeId: null, assigneeIds: [7, 9], enabled: true },
    { officeId: null, repairType: 'window', label: '门窗', assigneeId: 7, assigneeIds: [], enabled: true },
  ]; } };
  service.officeRepo = { async find() { return [{ id: 1, name: '一处' }, { id: 2, name: '二处' }]; } };
  service.accessService = {
    async getAccess() { return accessBase; },
    hasPermission() { return false; },
    async officeCommunityIds() { return []; },
  };
  const rows = await service.allowedNotebooks({ id: 7, tenantId: 3, role: 'staff' });
  assert.deepEqual(rows.map((row: any) => [row.officeId, row.repairType, row.canEdit]).sort((a: any, b: any) => a[0] - b[0]), [
    [1, 'electric', true], [2, 'access', true],
  ]);
});

test('角色授权按数据范围扩展笔记本，查看与编辑仍分开', async () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  service.ruleRepo = { async find() { return [
    { officeId: 1, repairType: 'electric', label: '电气', assigneeId: null, assigneeIds: [], enabled: true },
    { officeId: 2, repairType: 'access', label: '智能化', assigneeId: null, assigneeIds: [], enabled: true },
  ]; } };
  service.officeRepo = { async find() { return [{ id: 1, name: '一处' }, { id: 2, name: '二处' }]; } };
  service.accessService = {
    async getAccess() { return { ...accessBase, pages: { 'app:experience-notes': { view: true, edit: false, delete: false } }, communityIds: [11] }; },
    hasPermission(access: any, _keys: any, action: string) { return action === 'view' && access.pages['app:experience-notes'].view; },
    async officeCommunityIds(_tenantId: number, officeId: number) { return officeId === 1 ? [11] : [22]; },
  };
  const rows = await service.allowedNotebooks({ id: 6, tenantId: 3, role: 'staff' });
  assert.deepEqual(rows.map((row: any) => [row.officeId, row.repairType, row.canEdit]), [[1, 'electric', false]]);
});
