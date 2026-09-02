import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserFeedbackDto } from './dto';

test('意见建议最多4张图片、1个15秒视频', async () => {
  const valid = plainToInstance(CreateUserFeedbackDto, {
    content: '希望工单卡片字体可以再大一点',
    imageUrls: ['1', '2', '3', '4'],
    videoUrl: '/api/v1/upload/file?key=uploads/demo.mp4',
    videoDurationSeconds: 15,
  });
  assert.deepEqual(await validate(valid), []);

  const tooManyImages = plainToInstance(CreateUserFeedbackDto, {
    content: '图片过多',
    imageUrls: ['1', '2', '3', '4', '5'],
  });
  assert.ok((await validate(tooManyImages)).some((error) => error.property === 'imageUrls'));

  const tooLongVideo = plainToInstance(CreateUserFeedbackDto, {
    content: '视频过长',
    imageUrls: [],
    videoUrl: '/api/v1/upload/file?key=uploads/demo.mp4',
    videoDurationSeconds: 16,
  });
  assert.ok((await validate(tooLongVideo)).some((error) => error.property === 'videoDurationSeconds'));
});
