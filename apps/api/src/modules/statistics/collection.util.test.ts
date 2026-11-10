import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  buildCollectionDailyReport,
  buildCollectionFeeNatureReport,
  buildCollectionMonthlyReport,
  collectionGroupLabel,
  nextCollectionDate,
  parseCollectionDate,
  validateCollectionDateRange,
  validateCollectionYear,
} from './collection.util';
import { STATISTICS_NATURE_OPTIONS } from './statistics.util';

test('日期区间：必填/顺序/跨度<=366 天/真实日历日期', () => {
  assert.throws(() => parseCollectionDate('2026-02-30', 'dateFrom'), BadRequestException);
  assert.throws(() => parseCollectionDate('2026-13-01', 'dateFrom'), BadRequestException);
  assert.throws(() => parseCollectionDate('2026/03/01', 'dateFrom'), BadRequestException);
  assert.deepEqual(validateCollectionDateRange('2026-03-01', '2026-03-31'), {
    dateFrom: '2026-03-01', dateTo: '2026-03-31',
  });
  assert.throws(() => validateCollectionDateRange('2026-03-31', '2026-03-01'), BadRequestException);
  assert.throws(() => validateCollectionDateRange('2024-01-01', '2025-01-02'), BadRequestException);
  // 左闭右开上界：dateTo 的次日。
  assert.equal(nextCollectionDate('2026-03-31'), '2026-04-01');
  assert.equal(nextCollectionDate('2026-12-31'), '2027-01-01');
  assert.equal(nextCollectionDate('2024-02-29'), '2024-03-01');
});

test('月报表年度：2004–2100 整数', () => {
  assert.equal(validateCollectionYear(2026), 2026);
  assert.throws(() => validateCollectionYear(2003), BadRequestException);
  assert.throws(() => validateCollectionYear(2101), BadRequestException);
});

test('分组 label：管理处用旧系统名称，方式/收款人空值=未记录，收费项目缺失回退代码', () => {
  assert.equal(collectionGroupLabel('office', '02'), '枫桦景苑二期A');
  assert.equal(collectionGroupLabel('fee', '01', '管理费'), '管理费');
  assert.equal(collectionGroupLabel('fee', '99', null), '收费项目99');
  assert.equal(collectionGroupLabel('method', '', null), '未记录');
  assert.equal(collectionGroupLabel('cashier', '', null), '未记录');
  assert.equal(collectionGroupLabel('cashier', '张三', null), '张三');
});

test('日报矩阵：收款/退款/调整业务日升序，无业务不补行，收款合计不混入退款/调整', () => {
  const columns = [
    { code: '01', name: '管理费' },
    { code: '04', name: '泊位费' },
  ];
  const report = buildCollectionDailyReport(columns, [
    { date: '2026-10-06', feeCode: '04', receivedCents: 3_105_000, refundCents: 0, adjustCents: 0 },
    { date: '2026-10-05', feeCode: '01', receivedCents: 11_915_220, refundCents: 0, adjustCents: 0 },
    // 只有调整/退款的业务日期也保留；不把退款或调整混入收费项目收款列。
    { date: '2026-10-08', feeCode: '01', receivedCents: 0, refundCents: 0, adjustCents: 0 },
    { date: '2026-10-07', feeCode: '04', receivedCents: 0, refundCents: 0, adjustCents: -60_000 },
    { date: '2026-10-19', feeCode: '04', receivedCents: 0, refundCents: 15_000, adjustCents: 0 },
  ]);
  assert.deepEqual(report.rows.map((row) => row.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-19']);
  assert.equal(report.rows[2].adjustCents, -60_000);
  assert.equal(report.rows[3].refundCents, 15_000);
  assert.equal(report.rows.reduce((sum, row) => sum + row.refundCents, 0), report.refundTotalCents);
  assert.equal(report.rows.reduce((sum, row) => sum + row.adjustCents, 0), report.adjustTotalCents);
  assert.deepEqual(report.rows.map((row) => row.cells), [
    { '01': 11_915_220, '04': 0 },
    { '01': 0, '04': 3_105_000 },
    { '01': 0, '04': 0 },
    { '01': 0, '04': 0 },
  ]);
  assert.deepEqual(report.rows.map((row) => row.totalCents), [11_915_220, 3_105_000, 0, 0]);
  assert.equal(report.subtotal.totalCents, 15_020_220);
  assert.equal(report.refundTotalCents, 15_000);
  assert.equal(report.adjustTotalCents, -60_000);
});

test('收费项目×房屋性质矩阵：cell=净额、空性质不落列但计入行；总计=各列/块合计', () => {
  const columns = [
    { code: '01', name: '管理费' },
    { code: '04', name: '泊位费' },
    { code: '05', name: '临时停车费' },
  ];
  const natures = STATISTICS_NATURE_OPTIONS;
  const report = buildCollectionFeeNatureReport(columns, natures, [
    { feeCode: '01', natureCode: '01', receivedCents: 11_915_220, refundCents: 0, adjustCents: 0 },
    { feeCode: '04', natureCode: '', receivedCents: 3_105_000, refundCents: 15_000, adjustCents: 0 },
    { feeCode: '04', natureCode: '01', receivedCents: 0, refundCents: 0, adjustCents: -60_000 },
  ]);
  const fee01 = report.rows.find((row) => row.feeCode === '01')!;
  const fee04 = report.rows.find((row) => row.feeCode === '04')!;
  const fee05 = report.rows.find((row) => row.feeCode === '05')!;
  assert.equal(fee01.cells['01'], 11_915_220);
  assert.equal(fee01.netCents, 11_915_220);
  // 泊位费收款/退款行为空性质：不进任何性质列，但计入行块与净额。
  assert.equal(fee04.cells['01'], -60_000);
  assert.equal(fee04.cells['04'] ?? 0, 0);
  assert.deepEqual(
    [fee04.receivedCents, fee04.refundCents, fee04.adjustCents, fee04.netCents],
    [3_105_000, 15_000, -60_000, 3_045_000],
  );
  assert.equal(fee05.netCents, 0);
  assert.equal(report.rows.length, 3);
  assert.equal(report.subtotal.cells['01'], 11_915_220 - 60_000);
  assert.deepEqual(
    [report.subtotal.receivedCents, report.subtotal.refundCents, report.subtotal.adjustCents, report.subtotal.netCents],
    [15_020_220, 15_000, -60_000, 14_960_220],
  );
});

test('日报矩阵空数据：仍返回字典列，行/合计为 0', () => {
  const columns = [{ code: '01', name: '管理费' }];
  const report = buildCollectionDailyReport(columns, []);
  assert.deepEqual(report.columns, columns);
  assert.deepEqual(report.rows, []);
  assert.equal(report.subtotal.totalCents, 0);
  assert.equal(report.refundTotalCents, 0);
  assert.equal(report.adjustTotalCents, 0);
});

test('月报矩阵：固定 12 行（无数据月份=0），合计=全年', () => {
  const columns = [
    { code: '01', name: '管理费' },
    { code: '02', name: '租金' },
  ];
  const report = buildCollectionMonthlyReport(columns, [
    { month: 3, feeCode: '01', amountCents: 1000 },
    { month: 3, feeCode: '02', amountCents: 200 },
    { month: 12, feeCode: '01', amountCents: 50 },
  ]);
  assert.equal(report.rows.length, 12);
  assert.deepEqual(report.rows.map((row) => row.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(report.rows[2].cells, { '01': 1000, '02': 200 });
  assert.equal(report.rows[2].totalCents, 1200);
  assert.equal(report.rows[11].cells['01'], 50);
  assert.equal(report.subtotal.totalCents, 1250);
});
