import test from 'node:test';
import assert from 'node:assert/strict';
import { pickReadingCandidate, type OcrCandidateLike } from '../miniprogram/utils/meter-crop';
import { fitRoiToFrame, frameRoi } from '../miniprogram/utils/crop';

// 来自现场电表照片的真实候选（表号 20054564 与读数 02241888 都是 8 位）
const ELECTRIC: OcrCandidateLike[] = [
  { digits: '02241888', value: 22418.88, score: 1, box: [234, 1145, 1154, 1368] },
  { digits: '20054564', value: 200545.64, score: 0.9807, box: [47, 1886, 290, 1946] },
  { digits: '00000003', value: 0.03, score: 0.9074, box: [110, 497, 1159, 551] },
];
const WIDTH = 1536;
const HEIGHT = 2730;
const FRAME = { x: 0.1, y: 0.41, w: 0.8, h: 0.18 };

test('红框正对读数：选 02241888，不选表号', () => {
  const chosen = pickReadingCandidate(ELECTRIC, FRAME, WIDTH, HEIGHT, 8, '20054564');
  assert.equal(chosen?.digits, '02241888');
  assert.equal(chosen?.value, 22418.88);
});

test('红框偏到顶部：不能报没找到，退回全图读数', () => {
  const wrong = { x: 0.1, y: 0.0, w: 0.8, h: 0.12 };
  const chosen = pickReadingCandidate(ELECTRIC, wrong, WIDTH, HEIGHT, 8, '20054564');
  assert.equal(chosen?.digits, '02241888');
});

test('红框落在表号上：仍然不能把表号当读数', () => {
  const meterNoFrame = { x: 0.0, y: 0.67, w: 0.25, h: 0.08 };
  const chosen = pickReadingCandidate(ELECTRIC, meterNoFrame, WIDTH, HEIGHT, 8, '20054564');
  assert.equal(chosen?.digits, '02241888');
});

test('全图只有表号候选时，宁可返回空，也不返回表号', () => {
  const chosen = pickReadingCandidate(
    [{ digits: '20054564', value: 200545.64, score: 0.99, box: [47, 1886, 290, 1946] }],
    FRAME,
    WIDTH,
    HEIGHT,
    8,
    '20054564',
  );
  assert.equal(chosen, null);
});

test('自动把读数框进固定框后，候选仍在框内命中', () => {
  const source = { x: 0.152, y: 0.419, w: 0.445, h: 0.082 };
  const t = fitRoiToFrame(FRAME, source, WIDTH, HEIGHT);
  const roi = frameRoi(FRAME, t, WIDTH, HEIGHT);
  const chosen = pickReadingCandidate(ELECTRIC, roi, WIDTH, HEIGHT, 8, '20054564');
  assert.equal(chosen?.digits, '02241888');
});
