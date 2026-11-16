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
  service.context = async () => ({ tenantId: 3, userId: 7, member: true, canCreate: true,
    notebooks: await service.allowedNotebooks(), communities: [], allCommunities: [], skills: new Set() });
  const now = new Date();
  const base = { visibility: 'legacy', communityIds: [], repairTypes: [], allowEdit: false, allowDelete: false, revision: 1, updatedAt: now, updatedBy: null, createdBy: null };
  const sql: string[] = []; let keyword = '';
  const query: any = {
    where(text: string) { sql.push(text); return this; },
    andWhere(text: string, args?: any) { sql.push(text); if (args?.keyword) keyword = args.keyword; return this; },
    orderBy() { return this; }, addOrderBy() { return this; },
    async getMany() { return keyword === '%门禁%' ? [
      { ...base, id: 1, officeId: 1, repairType: 'electric', title: '门禁没反应', blocks: [{ id: 'a', type: 'paragraph', text: '先查电源' }] },
      { ...base, id: 2, officeId: 1, repairType: 'electric', title: '楼道灯不亮', blocks: [{ id: 'b', type: 'paragraph', text: '换灯管，门禁无关' }] },
    ] : []; },
  };
  service.noteRepo = { createQueryBuilder() { return query; } };
  service.favoriteRepo = { async find() { return [{ noteId: 2 }]; } };
  service.userNames = async () => new Map();
  const user = { id: 7, tenantId: 3, role: 'staff' };
  // 二处那篇不在可见范围里，标题再匹配也搜不到；正文里带关键词的也算
  const hit = await service.list(user, '门禁');
  assert.deepEqual(hit[0].notes.map((n: any) => [n.id, n.favorite]), [[1, false], [2, true]]);
  const none = await service.list(user, '电梯');
  assert.deepEqual(none[0].notes, []);
  assert.ok(sql.some((statement) => statement.includes('tenant_id') && statement.includes('deleted_at')));
  assert.ok(sql.some((statement) => statement.includes("visibility = 'legacy'") && statement.includes('office_id')));
  assert.ok(sql.some((statement) => statement.includes('search_text ILIKE')));
});

test('Markdown 新内容块保存时保留待办状态，分隔线不要求正文', () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  const cleaned = service.cleanBlocks([
    { id: 'todo', type: 'checklist', text: '  已测试通电  ', checked: true },
    { id: 'line', type: 'divider' },
    { id: 'quote', type: 'quote', text: '  业主反馈偶发  ' },
  ]);
  assert.deepEqual(cleaned, [
    { id: 'todo', type: 'checklist', text: '已测试通电', checked: true },
    { id: 'line', type: 'divider' },
    { id: 'quote', type: 'quote', text: '业主反馈偶发' },
  ]);
});

test('富文本文档保留排版并清除脚本和危险链接', () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  const [document] = service.cleanBlocks([{
    id: 'doc', type: 'document',
    html: '<h2>排查步骤</h2><p><strong>先断电</strong><script>alert(1)</script></p><a href="javascript:alert(2)">危险链接</a><img src="https://img.example.com/a.jpg" onerror="alert(3)">',
  }]);
  assert.match(document.html, /<h2>排查步骤<\/h2>/);
  assert.match(document.html, /<strong>先断电<\/strong>/);
  assert.match(document.html, /https:\/\/img\.example\.com\/a\.jpg/);
  assert.doesNotMatch(document.html, /script|javascript:|onerror/i);
});

test('纯图片文档可保存结构；私密正文不接受公共图片或跨作者未授权安全键', () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  const blocks = service.cleanBlocks([{ id: 'image-only', type: 'document', html: '<p><img src="https://public.invalid/image.jpg"></p>' }]);
  assert.match(blocks[0].html, /<img/);
  assert.throws(() => service.secureBlocks(blocks, 'private', { id: 1, tenantId: 1 }), /安全上传/);
  assert.doesNotThrow(() => service.secureBlocks(blocks, 'legacy', { id: 1, tenantId: 1 }));
  const other = [{ id: 'foreign', type: 'image', url: '/api/v1/repair-experiences/assets/view?key=protected%2Frepair-experiences%2F1%2F2%2F2026%2F11%2F16%2Fimage.jpg' }];
  assert.throws(() => service.secureBlocks(other, 'private', { id: 1, tenantId: 1 }), /他人未授权/);
});

test('安全附件拒绝默认短密钥、过期及重复查询参数，不向普通公开上传地址降级', async () => {
  const service = Object.create(RepairExperiencesService.prototype) as any;
  for (const secret of ['', 'change-me-in-prod', 'short']) {
    service.config = { get() { return secret; } };
    assert.throws(() => service.assetSignature('key', 1, 1, 0, 0, 123), /密钥未配置/);
  }
  await assert.rejects(service.readAsset({ key: 'protected/repair-experiences/1/1/2026/11/16/image.jpg', tenantId: '1', ownerId: '1', noteId: '0', revision: '0', expires: String(Math.floor(Date.now() / 1000) + 120), signature: ['0'.repeat(64)] }), /不存在/);
});
