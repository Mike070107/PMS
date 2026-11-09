import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  buildAnnualTable,
  filterRequestedOffices,
  formatPeriodRange,
  normalizeStatisticsFeeCategory,
  resolveStatisticsOffices,
  sortStatisticsFeeItems,
  STATISTICS_NATURE_OPTIONS,
  statisticsColumns,
  statisticsNatureName,
} from './statistics.util';

const communities = [
  { id: 1, name: '枫桦景苑一期' },
  { id: 2, name: '枫桦景苑二期' },
  { id: 16, name: '上海新家' },
];

test('管理处→PMS 小区映射：02/03 同属二期，05 无 PMS 小区', () => {
  const offices = resolveStatisticsOffices(communities, null);
  assert.deepEqual(offices.map((office) => office.officeCode), ['01', '02', '03', '04', '05']);
  assert.deepEqual(offices[0], {
    officeCode: '01', officeName: '枫桦景苑一期', communityId: 1, communityName: '枫桦景苑一期',
  });
  assert.deepEqual(offices[1], {
    officeCode: '02', officeName: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期',
  });
  assert.deepEqual(offices[2], {
    officeCode: '03', officeName: '枫桦景苑二期B', communityId: 2, communityName: '枫桦景苑二期',
  });
  assert.deepEqual(offices[3], {
    officeCode: '04', officeName: '上海新家', communityId: 16, communityName: '上海新家',
  });
  assert.deepEqual(offices[4], {
    officeCode: '05', officeName: '馨香北桥-二期', communityId: null, communityName: null,
  });
});

test('数据范围按 office→小区收敛：二期账号只看到 02/03，05 只对全公司可见', () => {
  assert.deepEqual(resolveStatisticsOffices(communities, [2]).map((office) => office.officeCode), ['02', '03']);
  assert.deepEqual(resolveStatisticsOffices(communities, [16]).map((office) => office.officeCode), ['04']);
  assert.deepEqual(resolveStatisticsOffices(communities, [1]).map((office) => office.officeCode), ['01']);
  // 全公司账号也要能展示没有 PMS 小区的 05。
  assert.deepEqual(resolveStatisticsOffices(communities, null).map((office) => office.officeCode), ['01', '02', '03', '04', '05']);
  // PMS 小区名对不上时（如开发库空数据）不伪造映射。
  assert.deepEqual(
    resolveStatisticsOffices([], null).map((office) => [office.officeCode, office.communityId]),
    [['01', null], ['02', null], ['03', null], ['04', null], ['05', null]],
  );
});

test('勾选管理处：未勾选=全部，勾选后只保留命中的', () => {
  const offices = resolveStatisticsOffices(communities, null);
  assert.deepEqual(filterRequestedOffices(offices, undefined).map((office) => office.officeCode), ['01', '02', '03', '04', '05']);
  assert.deepEqual(filterRequestedOffices(offices, []).map((office) => office.officeCode), ['01', '02', '03', '04', '05']);
  assert.deepEqual(filterRequestedOffices(offices, ['04', '01']).map((office) => office.officeCode), ['01', '04']);
  assert.deepEqual(filterRequestedOffices(offices, ['99']), []);
});

test('年度表格：没数据的年份补 0，合计与小计按整数分累加', () => {
  const offices = resolveStatisticsOffices(communities, null);
  const table = buildAnnualTable(offices, [2011, 2014, 2026], [
    { officeCode: '02', year: '2011', amountCents: '92100' },
    { officeCode: '02', year: 2014, amountCents: 47790 },
    { officeCode: '01', year: 2026, amountCents: '10000' },
  ]);
  const office01 = table.rows.find((row) => row.officeCode === '01')!;
  const office02 = table.rows.find((row) => row.officeCode === '02')!;
  assert.deepEqual(office01.cells, { '2011': 0, '2014': 0, '2026': 10000 });
  assert.equal(office01.totalCents, 10000);
  assert.deepEqual(office02.cells, { '2011': 92100, '2014': 47790, '2026': 0 });
  assert.equal(office02.totalCents, 139890);
  assert.deepEqual(table.subtotal, {
    cells: { '2011': 92100, '2014': 47790, '2026': 10000 },
    totalCents: 149890,
  });
  // 金额都是整数分，没有 *100 / /100 换算。
  assert.ok(table.rows.every((row) => Object.values(row.cells).every((cents) => Number.isInteger(cents))));
});

test('年度列生成与范围校验', () => {
  assert.deepEqual(statisticsColumns(2025, 2027), [2025, 2026, 2027]);
  assert.throws(() => statisticsColumns(2026, 2025), BadRequestException);
  assert.throws(() => statisticsColumns(2004, 2060), BadRequestException);
});

test('FWXZK 房屋性质字典按收费时点性质返回全量 code+中文名', () => {
  assert.equal(STATISTICS_NATURE_OPTIONS.length, 13);
  assert.deepEqual(STATISTICS_NATURE_OPTIONS.map((item) => item.code), [
    '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13',
  ]);
  assert.deepEqual(STATISTICS_NATURE_OPTIONS.find((item) => item.code === '04'), { code: '04', name: '商铺' });
  assert.deepEqual(STATISTICS_NATURE_OPTIONS.find((item) => item.code === '05'), { code: '05', name: '配套用房' });
  assert.deepEqual(STATISTICS_NATURE_OPTIONS.find((item) => item.code === '06'), { code: '06', name: '空房' });
  assert.equal(statisticsNatureName('01'), '商品房');
  assert.equal(statisticsNatureName('02'), '售后公房');
  assert.equal(statisticsNatureName('03'), '使用权房');
  assert.equal(statisticsNatureName('07'), '居住');
  assert.equal(statisticsNatureName('08'), '非居住');
  assert.equal(statisticsNatureName('99'), '性质99');

  assert.equal(formatPeriodRange('201410', '201412'), '201410-201412');
  assert.equal(formatPeriodRange('201410', '201410'), '201410');
  assert.equal(formatPeriodRange('201410', null), '201410');
  assert.equal(formatPeriodRange(null, '201412'), '201412');
  assert.equal(formatPeriodRange(null, null), null);
});

test('收费项目分类排序：代收费→其它→日常收费→停车收费，同分类按 code，空分类归其它', () => {
  const items = [
    { code: '01', name: '管理费', category: '日常收费' },
    { code: '12', name: '水费', category: '代收费' },
    { code: '09', name: '网络费', category: normalizeStatisticsFeeCategory(null) },
    { code: '04', name: '泊位费', category: '停车收费' },
    { code: '10', name: '青客租金', category: '其它' },
    { code: '13', name: '电费', category: '代收费' },
  ];
  assert.deepEqual(sortStatisticsFeeItems(items).map((item) => item.code), ['12', '13', '09', '10', '01', '04']);
  assert.equal(normalizeStatisticsFeeCategory('  '), '其它');
  assert.equal(normalizeStatisticsFeeCategory(' 日常收费 '), '日常收费');
  // 未知分类排在已知分类之后，不丢数据。
  assert.deepEqual(
    sortStatisticsFeeItems([{ code: '02', name: 'x', category: '新分类' }, { code: '01', name: 'y', category: '停车收费' }]).map((item) => item.code),
    ['01', '02'],
  );
});