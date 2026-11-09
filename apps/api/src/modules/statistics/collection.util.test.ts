import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  buildCollectionDailyReport,
  buildCollectionMonthlyReport,
  collectionGroupLabel,
  parseCollectionDate,
  validateCollectionDateRange,
  validateCollectionYear,
} from './collection.util';

test('日期区间：必填/顺序/跨度<=366 天/真实日历日期', () => {
  assert.deepEqual(validateCollectionDateRange('2026-03-01', '2026-03-31'), {
    dateFrom: '2026-03-01',
    dateTo: '2026-03-31',
  });
  // 闰日合法；单日区间合法。
  assert.doesNotThrow(() => validateCollectionDateRange('2024-02-29', '2024-02-29'));
  // 2024 是闰年：2024-01-01 → 2025-01-01 正好 366 天，允许；再多一天就 400。
  assert.doesNotThrow(() => validateCollectionDateRange('2024-01-01', '2025-01-01'));
  assert.throws(() => validateCollectionDateRange('2024-01-01', '2025-01-02'), BadRequestException);
  // from > to。
  assert.throws(() => validateCollectionDateRange('2026-03-31', '2026-03-01'), BadRequestException);
  // 语法合法但日历不存在：不静默纠正。
  for (const invalid of ['2026-02-30', '2026-13-01', '2026-00-10', '2023-02-29']) {
    assert.throws(() => validateCollectionDateRange(invalid, '2026-03-01'), BadRequestException, invalid);
  }
  // 格式不合法。
  for (const invalid of ['2026-3-1', '20260301', 'x', '', '2026-03-01T00:00:00Z']) {
    assert.throws(() => validateCollectionDateRange(invalid, '2026-03-01'), BadRequestException, invalid);
  }
  assert.throws(() => parseCollectionDate(undefined as never, 'dateFrom'), BadRequestException);
  // 两端都解析：单侧非法也要 400。
  assert.throws(() => validateCollectionDateRange('2026-03-01', '2026-02-31'), BadRequestException);
});

test('月报表年度：2004–2100 整数', () => {
  assert.equal(validateCollectionYear(2004), 2004);
  assert.equal(validateCollectionYear(2100), 2100);
  assert.equal(validateCollectionYear(2026), 2026);
  for (const invalid of [2003, 2101, 2026.5, Number.NaN, Infinity]) {
    assert.throws(() => validateCollectionYear(invalid), BadRequestException, String(invalid));
  }
});

test('分组 label：管理处用旧系统名称，方式/收款人空值=未填写，收费项目缺失回退代码', () => {
  assert.equal(collectionGroupLabel('office', '02'), '枫桦景苑二期A');
  assert.equal(collectionGroupLabel('office', '05'), '馨香北桥-二期');
  assert.equal(collectionGroupLabel('office', '99'), '管理处99');
  assert.equal(collectionGroupLabel('fee', '01', '管理费'), '管理费');
  assert.equal(collectionGroupLabel('fee', '01', '  '), '收费项目01');
  assert.equal(collectionGroupLabel('fee', '01', null), '收费项目01');
  assert.equal(collectionGroupLabel('fee', '', null), '未分类');
  assert.equal(collectionGroupLabel('method', '现金'), '现金');
  assert.equal(collectionGroupLabel('method', ''), '未填写');
  assert.equal(collectionGroupLabel('cashier', ''), '未填写');
  assert.equal(collectionGroupLabel('cashier', '张三'), '张三');
});

test('日报矩阵：行=发生日期升序、列补 0、未知收费项目自动成列、合计=各行之和', () => {
  const columns = [
    { code: '01', name: '管理费' },
    { code: '02', name: '租金' },
  ];
  const report = buildCollectionDailyReport(columns, [
    { date: '2026-03-02', feeCode: '01', amountCents: 600 },
    { date: '2026-03-02', feeCode: '01', amountCents: -400 },
    { date: '2026-03-01', feeCode: '01', amountCents: '1000' },
    { date: '2026-03-01', feeCode: '02', amountCents: 400 },
    { date: '2026-03-03', feeCode: '03', amountCents: 250 },
  ]);
  // 字典没有的 03 自动追加，名称回退代码，避免合计漏行。
  assert.deepEqual(report.columns.map((column) => column.code), ['01', '02', '03']);
  assert.deepEqual(
    report.rows.map((row) => [row.date, row.cells['01'], row.cells['02'], row.cells['03'], row.totalCents]),
    [
      ['2026-03-01', 1000, 400, 0, 1400],
      ['2026-03-02', 200, 0, 0, 200],
      ['2026-03-03', 0, 0, 250, 250],
    ],
  );
  assert.deepEqual(report.subtotal, {
    cells: { '01': 1200, '02': 400, '03': 250 },
    totalCents: 1850,
  });
  assert.ok(
    report.rows.every((row) => Object.values(row.cells).every((cents) => Number.isInteger(cents))),
  );
});

test('日报矩阵空数据：仍返回字典列，行/合计为 0；空 fee_code 归入未分类列', () => {
  const empty = buildCollectionDailyReport([{ code: '01', name: '管理费' }], []);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.subtotal, { cells: { '01': 0 }, totalCents: 0 });

  const blank = buildCollectionDailyReport([{ code: '01', name: '管理费' }], [
    { date: '2026-03-01', feeCode: null, amountCents: 120 },
  ]);
  assert.deepEqual(blank.columns, [
    { code: '01', name: '管理费' },
    { code: '', name: '未分类' },
  ]);
  assert.equal(blank.rows[0].cells[''], 120);
  assert.equal(blank.rows[0].totalCents, 120);
  assert.equal(blank.subtotal.totalCents, 120);
});

test('月报矩阵：固定 12 行（无数据月份=0），合计=全年', () => {
  const report = buildCollectionMonthlyReport(
    [
      { code: '01', name: '管理费' },
      { code: '02', name: '租金' },
    ],
    [
      { month: 3, feeCode: '01', amountCents: 600 },
      { month: '3', feeCode: '01', amountCents: -400 },
      { month: 4, feeCode: '01', amountCents: 2000 },
      { month: 12, feeCode: '02', amountCents: 500 },
    ],
  );
  assert.equal(report.rows.length, 12);
  assert.deepEqual(report.rows.map((row) => row.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(report.rows[0].totalCents, 0);
  assert.equal(report.rows[2].cells['01'], 200);
  assert.equal(report.rows[2].totalCents, 200);
  assert.equal(report.rows[3].totalCents, 2000);
  assert.equal(report.rows[11].cells['02'], 500);
  assert.deepEqual(report.subtotal, {
    cells: { '01': 2200, '02': 500 },
    totalCents: 2700,
  });
  // 非法月份行不参与（不会把 13 月算进 12 行表）。
  const dirty = buildCollectionMonthlyReport([], [{ month: 13, feeCode: '01', amountCents: 999 }]);
  assert.equal(dirty.rows.length, 12);
  assert.equal(dirty.subtotal.totalCents, 0);
});
