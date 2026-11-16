import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, QueryResult } from 'typeorm';
import { Broadcaster } from 'typeorm/subscriber/Broadcaster';
import sharp from 'sharp';
import { RepairExperienceFavorite, RepairExperienceNote } from '../../entities';
import { RepairExperiencesService } from './repair-experiences.service';
import { ExperienceDocumentSharing1789138800000 } from '../../migrations/1789138800000-ExperienceDocumentSharing';

// Real SQL/transactions/disk persistence; access/profile metadata and private object storage are controlled fixtures.
// No app bootstrap, env, remote DB or object-storage connection is used.
test('经验文档：真实磁盘创建保存重开、SQL ACL搜索分页、作者授权撤销、跨租户/工种、CAS与安全附件', async () => {
  const out = resolve(process.cwd(), '../../outputs/experience-notebook-20261116/backend');
  mkdirSync(out, { recursive: true });
  const directory = mkdtempSync(resolve(out, 'isolated-db-'));
  let pg = new PGlite(directory);
  const ds = new DataSource({ type: 'postgres', entities: [RepairExperienceNote, RepairExperienceFavorite], synchronize: false });
  await (ds as any).buildMetadatas(); (ds as any).isInitialized = true;
  const sql: string[] = [];
  ds.createQueryRunner = (): any => {
    const qr: any = { connection: ds, isReleased: false, isTransactionActive: false, data: {}, connect: async () => {}, release: async () => {},
      query: async (query: string, params: any[] = [], structured = false) => {
        sql.push(query); const out = await pg.query(query, params);
        if (!structured) return out.rows;
        const result = new QueryResult(); result.records = out.rows; result.raw = out.rows; result.affected = out.affectedRows; return result;
      } };
    qr.broadcaster = new Broadcaster(qr); qr.manager = ds.createEntityManager(qr);
    qr.startTransaction = async () => { await pg.exec('BEGIN'); qr.isTransactionActive = true; };
    qr.commitTransaction = async () => { await pg.exec('COMMIT'); qr.isTransactionActive = false; };
    qr.rollbackTransaction = async () => { await pg.exec('ROLLBACK'); qr.isTransactionActive = false; };
    return qr;
  };
  const users = Object.fromEntries([1, 2, 3, 4, 5, 7, 8, 9].map((id) => [id, { id, tenantId: 1, role: 'staff' }]));
  users[6] = { id: 6, tenantId: 2, role: 'staff' };
  const scopes: Record<number, number[]> = { 1: [11, 12, 13], 2: [11], 3: [11], 4: [12], 5: [11], 6: [21], 7: [], 8: [], 9: [] };
  const skills: Record<number, string[]> = { 1: ['electric'], 2: ['electric'], 3: ['water'], 4: ['electric'], 5: [], 6: ['electric'], 7: [], 8: [], 9: [] };
  const fixtures = [{ id: 11, name: '甲小区', officeId: 1, parentId: null }, { id: 12, name: '乙小区', officeId: 2, parentId: null }, { id: 13, name: '甲一期', officeId: null, parentId: 11 }];
  const rules = [1, 2].flatMap((officeId) => ['electric', 'water'].map((repairType) => ({ officeId, repairType, label: repairType === 'electric' ? '电工' : '水工', assigneeIds: officeId === 1 && repairType === 'electric' ? [9] : [], enabled: true })));
  const objects = new Map<string, { buffer: Buffer; type: string }>();
  const service: any = Object.create(RepairExperiencesService.prototype);
  Object.assign(service, {
    noteRepo: ds.getRepository(RepairExperienceNote), favoriteRepo: ds.getRepository(RepairExperienceFavorite),
    accessService: {
      getAccess: async (u: any) => ({ communityIds: scopes[u.id], scopeAll: false, pages: { 'experience-notes': { view: u.id !== 7 && u.id !== 9, edit: false } }, isTenantAdmin: u.id === 5 }),
      hasPermission: (a: any, _keys: any, action: string) => !!a.pages['experience-notes'][action],
      officeCommunityIds: async (_t: number, id: number) => id === 1 ? [11, 13] : [12],
    },
    communityRepo: { find: async ({ where }: any) => where.tenantId === 1 ? fixtures : [{ id: 21, name: '异租户', officeId: 3 }] },
    officeRepo: { find: async () => [{ id: 1, name: '甲处' }, { id: 2, name: '乙处' }] },
    ruleRepo: { find: async () => rules }, staffProfileRepo: { findOne: async ({ where }: any) => ({ skills: skills[where.userId] }) },
    userRepo: { find: async () => Object.values(users).map((u: any) => ({ id: u.id, name: `隔离用户${u.id}` })) },
    config: { get: (key: string, fallback?: string) => ({ JWT_SECRET: 'isolated-not-a-real-secret-0123456789-abcdef', APP_PUBLIC_BASE_URL: 'https://isolated.invalid', API_GLOBAL_PREFIX: 'api/v1' }[key] ?? fallback) },
    storage: { toDisplayUrl: (url: string) => url,
      putBuffer: async (buffer: Buffer, type: string, folder: string, name: string) => { const objectKey = `${folder}/2026/11/16/asset-${objects.size}-${name}`; objects.set(objectKey, { buffer, type }); return { objectKey }; },
      getObject: async (key: string) => { const object = objects.get(key); if (!object) throw Error('not found'); return { stream: Readable.from(object.buffer), contentType: object.type, contentLength: object.buffer.length }; },
    },
  });
  const body = (title: string, extra: any = {}) => ({ title, blocks: [{ id: 'body', type: 'document', html: '<p>实际持久化正文 关键词门禁</p>' }], ...extra });
  const updateBody = (note: any, extra: any = {}) => body(note.title, { blocks: note.blocks, revision: note.revision, ...extra });
  const cap = (url: string) => Object.fromEntries(new URL(url).searchParams);
  try {
    const audit = 'created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),created_by int,updated_by int';
    await pg.exec(`CREATE TABLE repair_experience_notes(id serial PRIMARY KEY,tenant_id int NOT NULL,office_id int NOT NULL,repair_type varchar(60) NOT NULL,title varchar(160) NOT NULL,blocks jsonb DEFAULT '[]',revision int DEFAULT 1,${audit});
      CREATE TABLE repair_experience_favorites(id serial PRIMARY KEY,tenant_id int,user_id int,note_id int,${audit},UNIQUE(tenant_id,user_id,note_id));
      INSERT INTO repair_experience_notes(tenant_id,office_id,repair_type,title,blocks,created_by) VALUES(1,1,'electric','旧笔记','[{"id":"old","type":"paragraph","text":"历史门禁正文"}]',4);`);
    await new ExperienceDocumentSharing1789138800000().up({ query: (q: string) => pg.query(q) } as any);
    const legacy = await service.detail(1, users[2]);
    assert.equal(legacy.visibility, 'legacy'); assert.equal(legacy.canEdit, false);
    assert.ok((await service.library(users[2], { q: '历史门禁' })).items.some((n: any) => n.id === 1));
    await assert.rejects(service.detail(1, users[4]), /不存在/); // legacy author is still outside old office/type ACL
    assert.equal((await service.library(users[4], { q: '历史门禁' })).total, 0);
    await assert.rejects(service.setFavorite(1, users[4], true), /不存在/);
    await assert.rejects(service.remove(1, 1, users[4]), /不存在/);
    const options = await service.sharingOptions(users[1]);
    assert.equal(options.canCreate, true); assert.equal(options.communities.find((c: any) => c.id === 13).officeId, 1);
    assert.equal((await service.sharingOptions(users[8])).communities.length, 0);
    assert.equal((await service.sharingOptions(users[9])).canCreate, true); // old auto notebook read permission
    await assert.rejects(service.update(1, updateBody(legacy, { visibility: 'private' }), users[9]), /只有作者/);
    const ownedLegacy = await ds.getRepository(RepairExperienceNote).save({ tenantId: 1, officeId: 1, repairType: 'electric', title: '旧作者明确转换', blocks: [{ id: 'old', type: 'paragraph', text: '保留旧语义' }], visibility: 'legacy', communityIds: [], repairTypes: [], allowEdit: false, allowDelete: false, revision: 1, createdBy: 9, updatedBy: 9 });
    const converted = await service.update(ownedLegacy.id, body('明确转私密', { revision: 1, visibility: 'private', communityIds: [], repairTypes: [] }), users[9]);
    assert.equal(converted.visibility, 'private');
    await assert.rejects(service.detail(converted.id, users[2]), /不存在/);
    await assert.rejects(service.create(body('无入口'), users[7]), /创建权限/);
    const noCommunity = await service.create(body('零小区私人'), users[8]);
    assert.equal(noCommunity.officeId, 0); assert.equal(noCommunity.visibility, 'private'); assert.equal(noCommunity.canEdit, true);
    const privateNote = await service.create(body('作者秘密', { officeId: 999, repairType: '_office', blocks: [{ id: 's', type: 'paragraph', text: '秘密针词' }] }), users[1]);
    assert.equal(privateNote.visibility, 'private'); assert.equal(privateNote.officeId, 0); assert.equal(privateNote.isOwner, true);
    const foreign = await service.create(body('异租户私密独词'), users[6]);
    assert.equal((await service.library(users[1], { q: '异租户私密独词' })).total, 0);
    await assert.rejects(service.detail(foreign.id, users[1]), /不存在/);
    await assert.rejects(new ExperienceDocumentSharing1789138800000().down({ query: (q: string) => pg.query(q) } as any), /lose their ACL/);
    assert.equal((await service.detail(privateNote.id, users[1])).visibility, 'private');
    for (const id of [2, 3, 4, 5, 6]) {
      await assert.rejects(service.detail(privateNote.id, users[id]), /不存在/);
      assert.equal((await service.library(users[id], { q: '秘密针词' })).total, 0);
      await assert.rejects(service.setFavorite(privateNote.id, users[id], true), /不存在/);
    }
    await assert.rejects(service.create(body('越区发布', { visibility: 'published', communityIds: [12], repairTypes: [] }), users[2]), /不能超出/);
    await assert.rejects(service.create(body('伪造工种', { visibility: 'published', communityIds: [11], repairTypes: ['unknown'] }), users[1]), /工种/);
    await assert.rejects(service.create(body('漏小区', { visibility: 'published' }), users[1]), /选择小区/);
    const published = await service.create(body('门禁发布 100%_完整', { visibility: 'published', communityIds: [11], repairTypes: ['electric'] }), users[1]);
    assert.equal((await service.detail(published.id, users[2])).canEdit, false);
    assert.equal((await service.library(users[2], { q: '实际持久化正文' })).total, 1);
    for (const id of [3, 4, 5, 6]) await assert.rejects(service.detail(published.id, users[id]), /不存在/); // admin lacking skills also fails closed
    await assert.rejects(service.update(published.id, updateBody(published), users[2]), /未授权编辑/);
    await assert.rejects(service.remove(published.id, published.revision, users[2]), /未授权删除/);
    assert.equal((await service.library(users[2], { q: '100%_' })).total, 1);
    assert.equal((await service.library(users[2], { q: '%' })).total, 1); // '%' is literal, not SQL wildcard
    assert.equal((await service.library(users[2], { q: "%' OR 1=1 --" })).total, 0);
    await service.setFavorite(published.id, users[2], true);
    assert.equal((await service.library(users[2], { view: 'favorites' })).total, 1);
    const granted = await service.update(published.id, updateBody(published, { allowEdit: true }), users[1]);
    assert.equal((await service.detail(granted.id, users[2])).canEdit, true);
    await assert.rejects(service.update(granted.id, updateBody(granted, { allowDelete: true }), users[2]), /只有作者/);
    const memberEdited = await service.update(granted.id, updateBody(granted, { title: '成员改正文' }), users[2]);
    assert.equal(memberEdited.createdByName, '隔离用户1'); assert.equal(memberEdited.isOwner, false);
    await assert.rejects(service.remove(memberEdited.id, memberEdited.revision, users[2]), /未授权删除/);
    const reverted = await service.update(memberEdited.id, updateBody(memberEdited, { visibility: 'private', communityIds: [], repairTypes: [], allowEdit: false }), users[1]);
    await assert.rejects(service.detail(reverted.id, users[2]), /不存在/);
    assert.equal((await service.library(users[2], { view: 'favorites' })).total, 0);
    await assert.rejects(service.update(reverted.id, updateBody(memberEdited), users[2]), /不存在/);
    const unlimited = await service.create(body('不限工种', { visibility: 'published', communityIds: [11, 12], repairTypes: [] }), users[1]);
    assert.equal((await service.detail(unlimited.id, users[3])).visibility, 'published');
    assert.equal((await service.detail(unlimited.id, users[5])).visibility, 'published');
    const cas = await service.create(body('CAS文档'), users[1]);
    const outcomes = await Promise.allSettled([service.update(cas.id, updateBody(cas, { title: '并发A' }), users[1]), service.update(cas.id, updateBody(cas, { title: '并发B' }), users[1])]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    assert.match((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.message, /更新/);
    const deletable = await service.create(body('可删文档', { visibility: 'published', communityIds: [11], repairTypes: [], allowDelete: true }), users[1]);
    await service.setFavorite(deletable.id, users[2], true);
    await assert.rejects(service.remove(deletable.id, undefined, users[2]), /revision/);
    await assert.rejects(service.remove(deletable.id, 99, users[2]), /更新/);
    assert.deepEqual(await service.remove(deletable.id, deletable.revision, users[2]), { deleted: true });
    await assert.rejects(service.detail(deletable.id, users[1]), /不存在/);
    assert.equal((await ds.getRepository(RepairExperienceFavorite).findBy({ noteId: deletable.id })).length, 0);
    const page = await service.library(users[1], { page: 2, pageSize: 1 });
    assert.equal(page.items.length, 1); assert.ok(page.total > 1);
    assert.ok(sql.some((q) => /COUNT/.test(q) && /created_by/.test(q) && /visibility/.test(q)));
    assert.ok(sql.some((q) => /LIMIT\s+1\s+OFFSET\s+1/.test(q) && /deleted_at"?\s+IS\s+NULL/.test(q)), sql.filter((q) => q.includes('LIMIT')).join('\n'));
    // Public URLs may remain publicly readable forever: refuse rather than pretending migration privatizes them.
    await assert.rejects(service.create(body('危险图', { blocks: [{ id: 'image', type: 'image', url: 'https://public.invalid/a.jpg' }] }), users[1]), /安全上传/);
    await assert.rejects(service.uploadAsset({ buffer: Buffer.from('%PDF-1.7') }, users[1]), /仅支持/);
    const buffer = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const asset = await service.uploadAsset({ buffer, originalname: 'image.png', mimetype: 'text/html' }, users[1]);
    assert.match(asset.objectKey, /^protected\/repair-experiences\/1\/1\//);
    assert.equal((await service.readAsset(cap(asset.displayUrl))).contentType, 'image/png');
    await assert.rejects(service.readAsset({ ...cap(asset.displayUrl), tenantId: '2' }), /不存在/);
    await assert.rejects(service.readAsset({ ...cap(asset.displayUrl), expires: '1' }), /不存在/);
    await assert.rejects(service.readAsset({ ...cap(asset.displayUrl), signature: '0'.repeat(64) }), /不存在/);
    const imageOnly = await service.create(body('纯图片文档', { blocks: [{ id: 'doc', type: 'document', html: `<p><img src="${asset.displayUrl}"></p>` }] }), users[1]);
    assert.equal(imageOnly.imageCount, 1); assert.match(imageOnly.blocks[0].html, /signature=/);
    const persistedImage = await ds.getRepository(RepairExperienceNote).findOneByOrFail({ id: imageOnly.id });
    assert.doesNotMatch(persistedImage.blocks[0].html!, /signature=|expires=/);
    const signedUrl = imageOnly.blocks[0].html.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&');
    await service.readAsset(cap(signedUrl));
    await assert.rejects(service.create(body('盗用图', { blocks: [{ id: 'x', type: 'image', url: asset.displayUrl }] }), users[2]), /他人未授权/);
    const changedImage = await service.update(imageOnly.id, updateBody(imageOnly, { title: '改名令旧签名失效' }), users[1]);
    await assert.rejects(service.readAsset(cap(signedUrl)), /不存在/);
    const currentUrl = changedImage.blocks[0].html.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&');
    await service.remove(changedImage.id, changedImage.revision, users[1]);
    await assert.rejects(service.readAsset(cap(currentUrl)), /不存在/);
    // New tables use the same SQL ACL, CAS, attachment signing and persisted search pipeline.
    const tableHtml = '<table onclick="bad()" style="width:999999px"><thead><tr><th colspan="2"><p>设备巡检</p></th></tr></thead><tbody><tr><td rowspan="2"><strong>阀门测压表格针词</strong></td><td>正常</td></tr><tr><td colspan="999999" onmouseover="bad()">维修结论</td></tr></tbody><tfoot><tr><td colspan="2">复核完成</td></tr></tfoot></table>';
    const tableDoc = await service.create(body('表格持久化', { blocks: [{ id: 'table', type: 'document', html: tableHtml }] }), users[1]);
    const cleanTable = tableDoc.blocks[0].html;
    assert.match(cleanTable, /<table><thead>/); assert.match(cleanTable, /rowspan="2"/); assert.match(cleanTable, /colspan="2"/);
    assert.doesNotMatch(cleanTable, /onclick|onmouseover|style=|999999/);
    assert.equal((await service.library(users[1], { q: '阀门测压表格针词' })).total, 1);
    for (const id of [2, 3, 4, 5, 6]) assert.equal((await service.library(users[id], { q: '阀门测压表格针词' })).total, 0);
    const sharedTable = await service.update(tableDoc.id, updateBody(tableDoc, { visibility: 'published', communityIds: [11], repairTypes: ['electric'] }), users[1]);
    assert.equal((await service.library(users[2], { q: '阀门测压表格针词' })).total, 1);
    assert.equal((await service.library(users[2], { q: '正常 维修结论' })).total, 1); // cell boundaries remain searchable whitespace
    for (const id of [3, 4, 5, 6]) assert.equal((await service.library(users[id], { q: '阀门测压表格针词' })).total, 0);
    await assert.rejects(service.update(sharedTable.id, updateBody(sharedTable, { blocks: [{ id: 'table', type: 'document', html: '<table><tr>' + '<td>x</td>'.repeat(21) + '</tr></table>' }] }), users[1]), /20列/);
    assert.equal((await service.detail(sharedTable.id, users[1])).revision, sharedTable.revision); // failed update leaves saved draft untouched
    const signedTableHtml = `<table><tbody><tr><td><p>图文单元格</p><img src="${asset.displayUrl.replace(/&/g, '&amp;')}"></td></tr></tbody></table>`;
    const imageTable = await service.create(body('表格安全图片', { blocks: [{ id: 'table-image', type: 'document', html: signedTableHtml }] }), users[1]);
    const tableImageUrl = imageTable.blocks[0].html.match(/src="([^"]+)"/)[1].replace(/&amp;/g, '&');
    assert.deepEqual((await service.readAsset(cap(tableImageUrl))).stream instanceof Readable, true);
    await assert.rejects(service.create(body('他人表格盗图', { blocks: [{ id: 'foreign-table', type: 'document', html: imageTable.blocks[0].html }] }), users[2]), /他人未授权/);
    await pg.close(); pg = new PGlite(directory);
    assert.equal((await service.detail(sharedTable.id, users[2])).blocks[0].html, cleanTable);
    assert.equal((await service.library(users[2], { q: '阀门测压表格针词' })).total, 1);
    assert.equal((await service.library(users[3], { q: '阀门测压表格针词' })).total, 0);
    const savedRow = await pg.query<{ search_text: string; blocks: Array<{ html: string }> }>('SELECT search_text, blocks FROM repair_experience_notes WHERE id = $1', [sharedTable.id]);
    assert.match(savedRow.rows[0].search_text, /正常 维修结论/); assert.equal(savedRow.rows[0].blocks[0].html, cleanTable);
    console.log('ISOLATED_EXPERIENCE_TABLE_PERSISTENCE_PASS table/ACL/cell-search/safe-spans/protected-images/reopen');
    const reopened = await service.detail(noCommunity.id, users[8]);
    assert.equal(reopened.visibility, 'private'); assert.match(reopened.blocks[0].html, /实际持久化正文/);
    assert.equal((await service.detail(privateNote.id, users[1])).title, '作者秘密');
    await assert.rejects(service.detail(privateNote.id, users[5]), /不存在/);
    console.log(`ISOLATED_EXPERIENCE_PERSISTENCE_PASS ${directory}`);
  } finally { await pg.close(); }
});
