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
  service.staffProfileRepo = { async findOne() { return null; } };
  const rows = await service.allowedNotebooks({ id: 7, tenantId: 3, role: 'staff' });
  // 自动进入的每个管理处都附带一本「本管理处公共」
  const picked = rows
    .map((row: any) => [row.officeId, row.repairType, row.canEdit])
    .sort((a: any, b: any) => a[0] - b[0] || (a[1] === '_office' ? -1 : 1));
  assert.deepEqual(picked, [
    [1, '_office', true], [1, 'electric', true], [2, '_office', true], [2, 'access', true],
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
  service.staffProfileRepo = { async findOne() { return null; } };
  const rows = await service.allowedNotebooks({ id: 6, tenantId: 3, role: 'staff' });
  assert.deepEqual(rows.map((row: any) => [row.officeId, row.repairType, row.canEdit]), [[1, '_office', false], [1, 'electric', false]]);
});

test('每个看得到的管理处都有一本「本管理处公共」：范围内维修工能写，只有查看权的角色不能写', async () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  service.ruleRepo = { async find() { return [
    { officeId: 1, repairType: 'electric', label: '电气', assigneeId: null, assigneeIds: [7], enabled: true },
    { officeId: 2, repairType: 'access', label: '智能化', assigneeId: null, assigneeIds: [], enabled: true },
  ]; } };
  service.officeRepo = { async find() { return [{ id: 1, name: '一处' }, { id: 2, name: '二处' }]; } };
  service.accessService = {
    async getAccess() { return { ...accessBase, pages: { 'app:experience-notes': { view: true, edit: false, delete: false } }, communityIds: [22] }; },
    hasPermission(access: any, _keys: any, action: string) { return action === 'view' && access.pages['app:experience-notes'].view; },
    async officeCommunityIds(_tenantId: number, officeId: number) { return officeId === 1 ? [11] : [22]; },
  };
  service.staffProfileRepo = { async findOne() { return null; } };
  const rows = await service.allowedNotebooks({ id: 7, tenantId: 3, role: 'staff' });
  const picked = rows
    .map((row: any) => [row.officeId, row.repairType, row.canEdit, row.isPublic])
    .sort((a: any, b: any) => a[0] - b[0] || Number(b[3]) - Number(a[3]));
  assert.deepEqual(picked, [
    [1, '_office', true, true], [1, 'electric', true, false],
    [2, '_office', false, true], [2, 'access', false, false],
  ]);
});

test('关键词只在看得到的笔记本里搜标题和正文，并带上收藏标记', async () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  service.allowedNotebooks = async () => [
    { officeId: 1, officeName: '一处', repairType: 'electric', repairTypeLabel: '电气', canEdit: true, isPublic: false },
  ];
  service.tenantId = () => 3;
  const now = new Date();
  service.noteRepo = { async find() { return [
    { id: 1, officeId: 1, repairType: 'electric', title: '门禁没反应', blocks: [{ id: 'a', type: 'paragraph', text: '先查电源' }], revision: 1, updatedAt: now, updatedBy: null, createdBy: null },
    { id: 2, officeId: 1, repairType: 'electric', title: '楼道灯不亮', blocks: [{ id: 'b', type: 'paragraph', text: '换灯管，门禁无关' }], revision: 1, updatedAt: now, updatedBy: null, createdBy: null },
    { id: 3, officeId: 2, repairType: 'electric', title: '门禁主板', blocks: [], revision: 1, updatedAt: now, updatedBy: null, createdBy: null },
  ]; } };
  service.favoriteRepo = { async find() { return [{ noteId: 2 }]; } };
  service.userNames = async () => new Map();
  const user = { id: 7, tenantId: 3, role: 'staff' };
  // 二处那篇不在可见范围里，标题再匹配也搜不到；正文里带关键词的也算
  const hit = await service.list(user, '门禁');
  assert.deepEqual(hit[0].notes.map((n: any) => [n.id, n.favorite]), [[1, false], [2, true]]);
  const none = await service.list(user, '电梯');
  assert.deepEqual(none[0].notes, []);
});
