import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRoiToFrame, frameRoi } from '../miniprogram/utils/crop';

const frame = { x: 0.1, y: 0.4, w: 0.8, h: 0.2 };
const W = 300;
const H = 500;

test('固定框不动时，ROI 就是框本身', () => {
  const roi = frameRoi(frame, { scale: 1, x: 0, y: 0, rotate: 0 }, W, H);
  assert.equal(Math.round(roi.x * 1000) / 1000, 0.1);
  assert.equal(Math.round(roi.y * 1000) / 1000, 0.4);
  assert.equal(Math.round(roi.w * 1000) / 1000, 0.8);
  assert.equal(Math.round(roi.h * 1000) / 1000, 0.2);
});

test('图片放大 2 倍，固定框对应的原图区域缩小一半', () => {
  const roi = frameRoi(frame, { scale: 2, x: 0, y: 0, rotate: 0 }, W, H);
  assert.equal(Math.round(roi.w * 1000) / 1000, 0.4);
  assert.equal(Math.round(roi.h * 1000) / 1000, 0.1);
  assert.equal(Math.round((roi.x + roi.w / 2) * 1000) / 1000, 0.5);
  assert.equal(Math.round((roi.y + roi.h / 2) * 1000) / 1000, 0.5);
});

test('自动把读数 ROI 放进固定框后，反算应包住同一块 ROI', () => {
  const source = { x: 0.32, y: 0.62, w: 0.16, h: 0.05 };
  const t = fitRoiToFrame(frame, source, W, H);
  const roi = frameRoi(frame, t, W, H);
  assert.ok(roi.x <= source.x + 0.002);
  assert.ok(roi.y <= source.y + 0.002);
  assert.ok(roi.x + roi.w >= source.x + source.w - 0.002);
  assert.ok(roi.y + roi.h >= source.y + source.h - 0.002);
  assert.ok(Math.abs(roi.x + roi.w / 2 - (source.x + source.w / 2)) < 0.01);
  assert.ok(Math.abs(roi.y + roi.h / 2 - (source.y + source.h / 2)) < 0.01);
});

test('图片旋转 90 度后固定框仍是同一个屏幕位置，ROI 轴对齐外接框会变宽', () => {
  const roi = frameRoi(frame, { scale: 1, x: 0, y: 0, rotate: 90 }, W, H);
  assert.ok(roi.w > 0);
  assert.ok(roi.h > 0);
  assert.ok(Math.abs(roi.x + roi.w / 2 - 0.5) < 0.02);
  assert.ok(Math.abs(roi.y + roi.h / 2 - 0.5) < 0.02);
});
