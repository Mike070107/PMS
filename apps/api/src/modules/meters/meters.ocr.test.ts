import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digitsToValue,
  formatReadingValue,
  normalizeMeterNo,
  parseMeterOcr,
  type OcrBoxItem,
} from './meter-ocr.util';
import { amountCentsOf, computeUsage, periodOf, round3 } from './meter-billing.util';

/**
 * 这两组框来自 2026-10-30 对两张现场照片跑 RapidOCR 的真实输出，
 * 不是手写的「理想输入」：水表照片里混着 GB/T 标准号，电表里表号和读数都是 8 位。
 * 任何解析改动都必须先过这两组。
 */
const WATER: OcrBoxItem[] = [
  { text: 'GB/T778-2018', score: 0.8654, box: [435, 744, 639, 805] },
  { text: 'Q3=m3/hR=80', score: 0.8349, box: [404, 780, 652, 849] },
  { text: '02405m', score: 0.7293, box: [376, 842, 747, 950] },
];

const ELECTRIC: OcrBoxItem[] = [
  { text: '三相四线', score: 0.773, box: [110, 497, 304, 551] },
  { text: 'DTSD501', score: 0.823, box: [478, 505, 643, 549] },
  { text: 'M沪制00000003号', score: 0.885, box: [764, 499, 1159, 545] },
  { text: '3×1.5(6)A50Hz', score: 0.808, box: [374, 577, 739, 633] },
  { text: '3X220/380V', score: 0.811, box: [72, 588, 341, 635] },
  { text: 'GB/T17215.301-2007', score: 0.839, box: [772, 582, 1152, 624] },
  { text: '三相电子式多功能电能表', score: 0.895, box: [7, 662, 1245, 806] },
  { text: '当前 总电量 上翻键', score: 0.7, box: [197, 988, 1159, 1084] },
  { text: '0224 1888', score: 0.8268, box: [234, 1145, 917, 1368] },
  { text: 'kwh', score: 0.5716, box: [773, 1339, 911, 1405] },
  { text: '6400imp/kWh', score: 0.8357, box: [133, 1517, 376, 1569] },
  { text: '2013年', score: 0.809, box: [1217, 1849, 1338, 1901] },
  { text: '20054564', score: 0.8708, box: [47, 1886, 290, 1946] },
  { text: '上海金凌智能电表有限公司', score: 0.86, box: [286, 1869, 1078, 2046] },
];

test('水表照片：从标准号和 Q3 里挑出 02405，不把 GB/T778 当表号', () => {
  const parsed = parseMeterOcr(WATER, {
    integerDigits: 5,
    decimalDigits: 0,
    width: 1536,
    height: 2730,
  });
  assert.equal(parsed.digits, '02405');
  assert.equal(parsed.value, 2405);
  assert.equal(parsed.meterNo, null);
  assert.deepEqual(parsed.meterNoCandidates, []);
  assert.ok(parsed.confidence >= 75);
  assert.equal(parsed.needsReview, false);
});

test('电表照片：0224/1888 合并，按 6+2 位补小数点；表号 20054564 单独识别', () => {
  const parsed = parseMeterOcr(ELECTRIC, {
    integerDigits: 6,
    decimalDigits: 2,
    width: 1536,
    height: 2730,
  });
  assert.equal(parsed.digits, '02241888');
  assert.equal(parsed.value, 22418.88);
  assert.equal(parsed.meterNo, '20054564');
  assert.ok(parsed.meterNoCandidates.includes('20054564'));
  assert.ok(parsed.confidence >= 90);
});

test('已建档表号参与匹配：档案表号能从候选里挑出来', () => {
  const parsed = parseMeterOcr(ELECTRIC, {
    integerDigits: 6,
    decimalDigits: 2,
    width: 1536,
    height: 2730,
    meterNoHint: 'No.2005-4564',
  });
  assert.equal(parsed.meterNo, '20054564');
});

test('显式小数点和全角数字都能解析', () => {
  assert.equal(digitsToValue('022418.88', 6, 2, true), 22418.88);
  assert.equal(digitsToValue('１２３４５', 5, 0), 12345);
  assert.equal(formatReadingValue(2405, 5, 0), '02405');
  assert.equal(formatReadingValue(22418.88, 6, 2), '022418.88');
  assert.equal(normalizeMeterNo('No. 2005-4564'), '20054564');
});

test('同一块屏上两个不同读数会要求复核，不硬选', () => {
  const parsed = parseMeterOcr(
    [
      { text: '12345', score: 0.9, box: [100, 100, 300, 160] },
      { text: '54321', score: 0.89, box: [320, 100, 520, 160] },
    ],
    { integerDigits: 5, decimalDigits: 0, width: 800, height: 600 },
  );
  assert.equal(parsed.needsReview, true);
  assert.ok(parsed.confidence <= 74);
});

test('用量：正常差值、倍率、归零进位；抄错一位不能被当归零', () => {
  assert.deepEqual(computeUsage(2410, 2405, 1, 5), { usage: 5, rollover: false });
  assert.deepEqual(computeUsage(2410, 2405, 2, 5), { usage: 10, rollover: false });
  assert.deepEqual(computeUsage(12, 99999, 1, 5), { usage: 13, rollover: true });
  const typo = computeUsage(2300, 2405, 1, 5);
  assert.equal(typo.usage, null);
  assert.match(String(typo.error), /小于上次/);
  assert.equal(computeUsage(100, null, 1, 5).usage, null);
});

test('金额：分整数、四舍五入，不用浮点直接乘', () => {
  assert.equal(amountCentsOf(24.05, 420), 10101);
  assert.equal(amountCentsOf(153.2, 65), 9958);
  assert.equal(amountCentsOf(0, 420), 0);
  assert.equal(amountCentsOf(1, 0), 0);
  assert.equal(round3(1.23456), 1.235);
});

test('账期按北京时间归月，服务器时区不影响', () => {
  assert.equal(periodOf(new Date('2026-10-31T16:30:00Z')), '2026-11');
  assert.equal(periodOf(new Date('2026-10-31T15:59:00Z')), '2026-10');
});
