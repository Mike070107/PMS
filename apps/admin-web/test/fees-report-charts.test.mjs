import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
test('图表零基线与正负金额使用相同线性尺度，零数据不产生除零', () => {
  const ts = createRequire(new URL('../../api/package.json', import.meta.url))('typescript');
  const exports = {};
  const source = readFileSync(new URL('../src/components/FeeReportCharts.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: () => ({}) });
  for (const [values, min, max] of [[[100,-50],-50,100], [[-100,-50],-100,0], [[50,100],0,100], [[0,0],0,1], [[],0,1]]) {
    const result = exports.feeScale(values);
    assert.equal(result.min, min); assert.equal(result.max, max);
  }
});
test('真实图表组件渲染保留负数和精确金额，并显示空数据状态', () => {
  const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
  const webRequire = createRequire(new URL('../package.json', import.meta.url));
  const ts = apiRequire('typescript');
  const React = webRequire('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server');
  const exports = {};
  const source = readFileSync(new URL('../src/components/FeeReportCharts.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: (name) => {
      if (name === '@pms/shared-types') return { formatFeeMoney: value => `¥${(value / 100).toFixed(2)}` };
      if (name === 'antd') return { Spin: ({children}) => children, Empty: Object.assign(({description}) => React.createElement('div', null, description), {PRESENTED_IMAGE_SIMPLE:null}) };
      return webRequire(name);
    },
  });
  const trend = renderToStaticMarkup(React.createElement(exports.FeeTrendChart, { rows: [{bucket:'2026-10-01',amountCents:-1234,count:1},{bucket:'2026-10-02',amountCents:2345,count:2}], loading:false, label: value => value }));
  assert.match(trend, /-12\.34/); assert.match(trend, /23\.45/); assert.doesNotMatch(trend, /NaN|Infinity/);
  const breakdown = renderToStaticMarkup(React.createElement(exports.FeeBreakdownChart, {rows:[{key:'refund',name:'红冲',amountCents:-1234,count:1,share:null}],loading:false}));
  assert.match(breakdown, /is-negative/); assert.match(breakdown, /不适用/);
  const empty = renderToStaticMarkup(React.createElement(exports.FeeTrendChart, {rows:[],loading:false,label: value=>value}));
  assert.match(empty, /所选日期没有收费数据/); assert.doesNotMatch(empty, /polyline/);
});
test('收费明细按实收日期倒序，未收费排最后，同时间按ID稳定排序', () => {
  const source = readFileSync(new URL('../../api/src/modules/fees/fees.service.ts', import.meta.url), 'utf8');
  const list = source.slice(source.indexOf('qb.select(['), source.indexOf('const rows = await qb.getRawMany'));
  assert.match(list, /orderBy\('f.paid_at', 'DESC', 'NULLS LAST'\)/);
  assert.match(list, /addOrderBy\('f.id', 'DESC'\)/);
});
test('报表真实趋势与四类汇总接入图表，保留明细和导出', () => {
  const source = readFileSync(new URL('../src/pages/FeesPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /<FeeTrendChart rows=\{data\?\.trend \?\? \[\]\}/);
  assert.match(source, /<FeeBreakdownChart rows=\{rows\}/);
  assert.match(source, /<details[^>]*>[\s\S]*<summary>查看趋势明细/);
  assert.match(source, /导出 Excel/);
});
