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

test('倍率表：小数位先保留，乘倍率后再算钱', () => {
  // 表盘 00001.23，倍率 80 -> 98.4，不能被整数位截成 1 或 98
  const small = computeUsage(1.23, 0, 80, 6);
  assert.equal(small.usage, 98.4);
  assert.equal(amountCentsOf(small.usage as number, 250), 24600);

  // 三相电表 022322.24 - 022300.00 = 22.24，倍率 20 -> 444.8
  const electric = computeUsage(22322.24, 22300, 20, 6);
  assert.equal(electric.usage, 444.8);
  assert.equal(amountCentsOf(electric.usage as number, 65), 28912);
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


test('已知表号即使分数更高也不能作为读数', () => {
  const parsed = parseMeterOcr([
    { text: '20054564', score: 0.99, box: [20, 400, 600, 500] },
    { text: '02241888', score: 0.80, box: [20, 100, 600, 200] },
  ], { integerDigits: 6, decimalDigits: 2, meterNoHint: '20054564' });
  assert.equal(parsed.value, 22418.88);
});

test('位数不符必须复核，不把高 OCR 字符分数当读数可靠性', () => {
  const parsed = parseMeterOcr([{ text: '00892', score: 0.99 }], {
    integerDigits: 6, decimalDigits: 0,
  });
  assert.equal(parsed.needsReview, true);
});


test('大模型显式小数点不能被剥除后变成整数', async () => {
  const { MeterOcrService } = await import('./meter-ocr.service');
  const service = new MeterOcrService({} as any, {} as any, {
    isReady: async () => true,
    askImageJson: async () => ({ reading: '123.45', confidence: 90 }),
  } as any);
  const parsed = await (service as any).runLlm({ integerDigits: 6, decimalDigits: 2 }, Buffer.from('image'), 1);
  assert.equal(parsed.value, 123.45);
});

test('框内空白不得退回框外数字；识别必须传入档案表号排除', async () => {
  const { MeterOcrService } = await import('./meter-ocr.service');
  const axios = (await import('axios')).default;
  const original = axios.post;
  try {
    axios.post = (async () => ({ data: { ok: true, width: 1000, height: 1000, items: [
      { text: '20054564', score: 0.99, box: [100, 100, 400, 180] },
    ] } })) as any;
    const service = new MeterOcrService({ get: () => '' } as any, {} as any, {} as any);
    const meter = { integerDigits: 6, decimalDigits: 2, meterNo: '20054564' };
    const found = await (service as any).runSidecar('http://isolated', Buffer.from('image'), undefined, false, meter, 0,
      { x: 0.5, y: 0.5, w: 0.4, h: 0.2 });
    assert.equal(found.parsed.value, null);
    const full = await (service as any).runSidecar('http://isolated', Buffer.from('image'), undefined, false, meter);
    assert.equal(full.parsed.value, null);
  } finally { axios.post = original; }
});


test('侧拍 90 度的拆分字轮按识别方向拼接，候选框还原到原图', async () => {
  const { MeterOcrService } = await import('./meter-ocr.service');
  const axios = (await import('axios')).default;
  const original = axios.post;
  try {
    axios.post = (async () => ({ data: { ok: true, width: 1000, height: 1000, orientation: 90, items: [
      { text: '0224', score: 0.9, box: [100, 699, 160, 899] },
      { text: '1888', score: 0.9, box: [100, 479, 160, 679] },
    ] } })) as any;
    const service = new MeterOcrService({ get: () => '' } as any, {} as any, {} as any);
    const found = await (service as any).runSidecar('http://isolated', Buffer.from('image'), undefined, false,
      { integerDigits: 6, decimalDigits: 2, meterNo: '20054564' }, 90);
    assert.equal(found.parsed.value, 22418.88);
    assert.deepEqual(found.parsed.candidates[0].box, [100, 479, 160, 899]);
  } finally { axios.post = original; }
});


test('裁切图交给视觉模型，响应与留档仍指向原图', async () => {
  const { Readable } = await import('node:stream');
  const { MeterOcrService } = await import('./meter-ocr.service');
  const original = Buffer.from('original-full-photo');
  const crop = Buffer.from([137,80,78,71,13,10,26,10,1]);
  let sent: any;
  const service = new MeterOcrService({ get: () => '' } as any, {
    getObject: async (key: string) => ({ stream: Readable.from([key.endsWith('crop.png') ? crop : original]) }),
    fileUrl: (key: string) => key,
  } as any, {
    isReady: async () => true,
    askImageJson: async (_tenant: number, _system: string, _prompt: string, image: any) => {
      sent = image; return { reading: '008922', confidence: 90 };
    },
  } as any);
  const result = await (service as any).recognize({ integerDigits: 6, decimalDigits: 0, meterNo: 'W-1' },
    'uploads/original.jpg', undefined, { tenantId: 1 }, { x: .2, y: .3, w: .5, h: .1 }, 'uploads/crop.png');
  assert.deepEqual(sent?.buffer, crop);
  assert.equal(sent.contentType, 'image/png');
  assert.equal(result.imageUrl, 'uploads/original.jpg');
  assert.equal(result.value, 8922);
});

test('视觉模型问号不能被删除后误当成完整读数', async () => {
  const { MeterOcrService } = await import('./meter-ocr.service');
  const service = new MeterOcrService({} as any, {} as any, {
    isReady: async () => true,
    askImageJson: async () => ({ reading: '0088?', uncertain: true, confidence: 99 }),
  } as any);
  const parsed = await (service as any).runLlm({ integerDigits: 5, decimalDigits: 0 }, Buffer.from('image'), 1);
  assert.equal(parsed?.value, null);
  assert.equal(parsed?.needsReview, true);
});
