import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedbackService } from './feedback.service';
import { FEEDBACK_MAX_ATTACHMENT_BYTES } from './dto';

/** 合成邮箱：不连数据库。覆盖附件校验、旧字段兼容、通知同分钟合并、状态更新。 */
const req: any = { headers: { 'user-agent': 'SyntheticBot/1.0' }, get: () => 'feedback.local', body: {} };
const auth: any = { id: 7, tenantId: 1 };

function fixture(storageOverride?: any) {
  const state: any = { notifications: [], calls: [], rows: [], seq: 0, statCalls: 0 };
  const feedbackRepo: any = {
    create: (value: any) => ({ ...value }),
    save: async (value: any) => {
      const row = { ...value, id: ++state.seq, createdAt: new Date() };
      state.rows.push(row);
      return row;
    },
    findOne: async ({ where }: any) => state.rows.find((row: any) => row.id === where.id && row.tenantId === where.tenantId) || null,
  };
  const userRepo: any = {
    findOne: async () => ({ id: 7, name: '张三', phone: '13800000000' }),
    find: async () => [],
  };
  const notificationRepo: any = {
    findOne: async ({ where }: any) => state.notifications
      .filter((row: any) => row.tenantId === where.tenantId && row.receiverId === where.receiverId
        && row.eventKey === where.eventKey && row.createdAt >= where.createdAt.value)
      .sort((a: any, b: any) => b.id - a.id)[0] || null,
    save: async (row: any) => {
      const index = state.notifications.findIndex((item: any) => item.id === row.id);
      if (index >= 0) state.notifications[index] = row;
      else state.notifications.push(row);
      return row;
    },
  };
  const logRepo: any = {
    findOne: async () => null,
    save: async (value: any) => value,
  };
  const notifications = {
    notifyUser: async (input: any) => {
      state.calls.push(input);
      state.notifications.push({
        id: ++state.seq, tenantId: input.tenantId, receiverId: input.receiverId, eventKey: input.eventKey,
        title: input.title, payload: { ...input.payload }, createdAt: new Date(), readAt: null,
      });
      return { externalSent: false, reason: '仅站内通知（合成）' };
    },
  };
  const access = { userIdsWithPermission: async () => [8, 9] };
  const storage = storageOverride ?? {
    statObject: async () => { state.statCalls += 1; return { size: 1024, contentType: 'image/jpeg' }; },
  };
  const service: any = new (FeedbackService as any)(feedbackRepo, userRepo, notificationRepo, logRepo, notifications, access, storage);
  return { service, state, logRepo, feedbackRepo, storage, access };
}

const attachment = (overrides: any = {}) => ({
  url: '/api/v1/upload/file?key=uploads/2026/11/08/demo.jpg',
  name: '截图.jpg',
  size: 1024,
  mime: 'image/jpeg',
  ...overrides,
});

test('附件：数量/真实大小/类型/来源校验，旧字段仍可提交', async () => {
  const f = fixture();
  const created = await f.service.create({
    content: '点完工提交后提示失败，重试两次一样',
    kind: 'error',
    source: 'web',
    attachments: [attachment()],
    context: { page: '/work-orders/45', recentErrors: [{ at: '2026-11-08T00:00:00Z', message: '提交失败' }] },
  }, auth, req);
  assert.equal(created.kind, 'error');
  assert.equal(created.source, 'web');
  assert.equal(created.status, 'pending');
  const saved = f.state.rows[0];
  assert.deepEqual(saved.attachments[0], { url: attachment().url, name: '截图.jpg', size: 1024, mime: 'image/jpeg' });
  assert.equal(saved.context.page, '/work-orders/45');
  assert.equal(saved.context.userAgent, 'SyntheticBot/1.0');
  assert.equal(saved.context.recentErrors[0].message, '提交失败');

  await assert.rejects(
    f.service.create({ content: '附件过多', attachments: Array.from({ length: 6 }, (_, i) => attachment({ url: `/api/v1/upload/file?key=uploads/x/${i}.jpg` })) }, auth, req),
    /最多 5 个/,
  );
  await assert.rejects(
    f.service.create({ content: '声明超大', attachments: [attachment({ size: FEEDBACK_MAX_ATTACHMENT_BYTES + 1 })] }, auth, req),
    /不能超过 20MB/,
  );
  const big = fixture({ statObject: async () => ({ size: FEEDBACK_MAX_ATTACHMENT_BYTES + 1, contentType: 'video/mp4' }) });
  await assert.rejects(big.service.create({ content: '实际超大', attachments: [attachment({ mime: 'video/mp4', url: '/api/v1/upload/file?key=uploads/big.mp4' })] }, auth, req), /不能超过 20MB/);
  const broken = fixture({ statObject: async () => { throw new Error('not found'); } });
  await assert.rejects(broken.service.create({ content: '附件丢失', attachments: [attachment({ url: '/api/v1/upload/file?key=uploads/missing.jpg' })] }, auth, req), /无法校验/);
  await assert.rejects(f.service.create({ content: '外链', attachments: [attachment({ url: 'https://evil.example.com/api/v1/upload/file?key=uploads/x.jpg' })] }, auth, req), /必须先通过系统上传/);
  await assert.rejects(f.service.create({ content: '类型不对', attachments: [attachment({ mime: 'text/plain', url: '/api/v1/upload/file?key=uploads/x.txt' })] }, auth, req), /仅支持/);

  // 旧小程序字段：不经过对象存储校验，折叠进统一 attachments，且 kind/source 有默认值。
  const legacy = fixture();
  const legacyCreated = await legacy.service.create({
    content: '希望字体大一点',
    imageUrls: ['/api/v1/upload/file?key=uploads/old-1.jpg'],
    videoUrl: '/api/v1/upload/file?key=uploads/old-2.mp4',
    videoDurationSeconds: 8,
  } as any, auth, req);
  const old = legacy.state.rows[0];
  assert.equal(old.kind, 'suggestion');
  assert.equal(old.source, 'miniapp-staff');
  assert.equal(legacyCreated.kind, 'suggestion');
  assert.equal(legacy.state.statCalls, 0, '旧字段不做对象存储实测');
  assert.deepEqual(old.attachments.map((item: any) => item.url), ['/api/v1/upload/file?key=uploads/old-1.jpg', '/api/v1/upload/file?key=uploads/old-2.mp4']);
});

test('通知：有 logs:view 的管理员收到类型/提交人/摘要/是否看报错，同一分钟多条只推一次', async () => {
  const f = fixture();
  const firstCheck = await f.service.create({ content: '第一条反馈', kind: 'suggestion', source: 'web' }, auth, req);
  const second = await f.service.create({ content: '第二条反馈', kind: 'error', source: 'web', context: { recentErrors: [{ at: '2026-11-08T00:00:00Z', message: '接口 500' }] } }, auth, req);
  assert.equal(f.state.calls.length, 2, '两个管理员各推一次，不因同分钟第二条重复推送');
  assert.deepEqual(f.state.calls.map((call: any) => call.receiverId).sort(), [8, 9]);
  const first = f.state.calls[0];
  assert.match(first.title, /意见与建议|异常反馈/);
  assert.equal(first.payload.submitter, '张三');
  assert.match(String(first.payload.summary), /第一条反馈/);
  assert.equal(first.payload.needsErrorCheck, false);
  const pushed = f.state.notifications.filter((row: any) => row.payload?.count);
  assert.equal(pushed.length, 2);
  for (const row of pushed) {
    assert.equal(row.payload.count, 2, '同分钟第二条合并进同一条站内信');
    assert.equal(row.payload.latestId, second.id);
    assert.deepEqual(row.payload.feedbackIds, [firstCheck.id, second.id]);
    assert.equal(row.payload.needsErrorCheck, true, '合并后只要有一条异常就需要看报错');
    assert.match(row.title, /收到 2 条反馈/);
  }
});

test('状态更新：统一表与历史 log-<id> 都能标记已处理/撤回，非法 id 与不存在返回明确错误', async () => {
  const f = fixture();
  f.state.rows.push({ id: 11, tenantId: 1, status: 'pending' });
  assert.deepEqual(await f.service.update('11', {}, auth), { ok: true, id: 11, status: 'handled' });
  assert.equal(f.state.rows.find((row: any) => row.id === 11).status, 'handled');
  assert.deepEqual(await f.service.update('11', { status: 'pending' }, auth), { ok: true, id: 11, status: 'pending' });

  const log = { id: 5, tenantId: 1, category: 'feedback', detail: { feedbackStatus: 'new', history: [] }, success: false, updatedBy: null as any };
  f.logRepo.findOne = async ({ where }: any) => (where.id === 5 && where.tenantId === 1 ? log : null);
  f.logRepo.save = async (value: any) => value;
  assert.deepEqual(await f.service.update('log-5', {}, auth), { ok: true, id: 'log-5', status: 'handled' });
  assert.equal((log.detail as any).feedbackStatus, 'resolved');
  assert.equal((log.detail as any).history.length, 1);
  assert.equal(log.success, true);
  await assert.rejects(f.service.update('abc', {}, auth), /不合法/);
  await assert.rejects(f.service.update('999', {}, auth), /不存在/);
});

test('通知失败不阻断反馈提交', async () => {
  const f = fixture();
  f.access.userIdsWithPermission = async () => { throw new Error('permission store unavailable'); };
  const created = await f.service.create({ content: '通知坏了也要能提交', source: 'web' }, auth, req);
  assert.ok(created.id);
  assert.equal(f.state.rows.length, 1);
});
