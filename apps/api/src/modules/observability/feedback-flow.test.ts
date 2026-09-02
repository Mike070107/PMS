import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservabilityService } from './observability.service';

test('后台更新反馈状态后保存回复并通知原提交人', async () => {
  const service = Object.create(ObservabilityService.prototype) as any;
  const row: any = {
    id: 18,
    tenantId: 3,
    category: 'feedback',
    actorUserId: 27,
    detail: {
      feedbackStatus: 'new',
      history: [{ status: 'new', at: '2026-09-01T00:00:00.000Z', by: 27 }],
    },
    success: false,
  };
  let notified: any;
  service.logRepo = {
    async findOne() { return row; },
    async save(value: any) { return value; },
  };
  service.notifications = {
    async notifyUser(input: any) { notified = input; },
  };

  await service.updateFeedbackStatus(
    18,
    { status: 'resolved', note: '已修复，请重新进入页面查看。' },
    { id: 9, tenantId: 3 },
  );

  assert.equal(row.detail.feedbackStatus, 'resolved');
  assert.equal(row.detail.handlingNote, '已修复，请重新进入页面查看。');
  assert.equal(row.success, true);
  assert.equal(notified.receiverId, 27);
  assert.equal(notified.eventKey, 'feedback_status_changed');
  assert.equal(notified.payload.note, '已修复，请重新进入页面查看。');
  assert.equal(notified.page, 'pages/feedback-history/feedback-history?id=18');
});

test('我的反馈只下发用户可见内容，不泄露排障上下文', async () => {
  const service = Object.create(ObservabilityService.prototype) as any;
  let capturedWhere: any;
  service.logRepo = {
    async find(options: any) {
      capturedWhere = options.where;
      return [{
        id: 20,
        message: '点完工后一直失败',
        createdAt: new Date('2026-09-02T01:00:00.000Z'),
        updatedAt: new Date('2026-09-02T02:00:00.000Z'),
        detail: {
          feedbackType: 'error',
          feedbackStatus: 'processing',
          handlingNote: '正在检查这张工单。',
          context: { token: '不应返回' },
          stack: '不应返回',
          attachments: [{ type: 'image', url: 'https://example.com/a.jpg' }],
          history: [
            { status: 'new', at: '2026-09-02T01:00:00.000Z', by: 7 },
            { status: 'processing', note: '正在检查这张工单。', at: '2026-09-02T02:00:00.000Z', by: 9 },
          ],
        },
      }];
    },
  };

  const result = await service.listMyFeedback({ id: 7, tenantId: 3 });

  assert.deepEqual(capturedWhere, { tenantId: 3, category: 'feedback', actorUserId: 7 });
  assert.equal(result[0].handlingNote, '正在检查这张工单。');
  assert.deepEqual(result[0].attachments, [{ type: 'image', url: 'https://example.com/a.jpg' }]);
  assert.equal(result[0].history[1].note, '正在检查这张工单。');
  assert.equal('context' in result[0], false);
  assert.equal('stack' in result[0], false);
});
