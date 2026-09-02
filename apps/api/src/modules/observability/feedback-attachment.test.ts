import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { safeFeedbackAttachments } from './feedback-attachment';

const req = { get: () => 'prsznh.cn' } as unknown as Request;
const image = (index: number) => ({
  type: 'image' as const,
  url: `https://prsznh.cn/api/v1/upload/file?key=uploads%2Fimage-${index}.jpg`,
});
const video = (index: number) => ({
  type: 'video' as const,
  url: `/api/v1/upload/file?key=uploads%2Fvideo-${index}.mp4`,
});

test('反馈允许最多 4 张系统图片和 1 个系统视频', () => {
  assert.equal(safeFeedbackAttachments([image(1), image(2), image(3), image(4), video(1)], req).length, 5);
});

test('反馈拒绝超过图片/视频上限以及外部伪造附件', () => {
  assert.throws(() => safeFeedbackAttachments([image(1), image(2), image(3), image(4), image(5)], req));
  assert.throws(() => safeFeedbackAttachments([video(1), video(2)], req));
  assert.throws(() => safeFeedbackAttachments([{
    type: 'image',
    url: 'https://evil.example/api/v1/upload/file?key=uploads%2Ftrack.jpg',
  }], req));
});
