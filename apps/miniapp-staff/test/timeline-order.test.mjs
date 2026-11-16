import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const ts = requireApi('typescript');
requireApi('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });
const shared = requireApi(fileURLToPath(new URL('../../../packages/shared-types/src/index.ts', import.meta.url)));
const miniapp = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../../packages/miniapp-ui/src/format.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: miniapp, require: name => { assert.equal(name, '@pms/shared-types'); return shared; } });
const { buildTimeline } = miniapp;
const logs = Object.freeze([
  Object.freeze({ id: 2, toStatus: 'working', createdAt: '2026-11-16T02:00:00Z', note: '中间', attachments: ['photo'] }),
  Object.freeze({ id: 1, toStatus: 'created', createdAt: '2026-11-16T01:00:00Z', note: '最早' }),
  Object.freeze({ id: 3, toStatus: 'done', createdAt: '2026-11-16T03:00:00Z', note: '最新' }),
]);
const labels = { created: '已报修', working: '维修中', done: '完工' };
test('两小程序真实buildTimeline：乱序输入仍最新在上，停留按相邻真实时间计算，不改源数组', () => {
  const rows = buildTimeline(logs, labels, { finished: true });
  assert.deepEqual(Array.from(rows, r => r.id), [3, 2, 1]);
  assert.equal(rows[0].stay, '');
  assert.equal(rows[1].stay, `停留 ${shared.formatDuration(logs[0].createdAt, logs[2].createdAt)}`);
  assert.equal(rows[2].stay, `停留 ${shared.formatDuration(logs[1].createdAt, logs[0].createdAt)}`);
  assert.deepEqual(rows[1].attachments, ['photo']);
  assert.deepEqual(logs.map(r => r.id), [2, 1, 3]);
});
test('未结束小程序最新节点继续计算到现在，历史节点不续计', () => {
  const rows = buildTimeline(logs.slice(0, 2), labels);
  assert.equal(rows[0].id, 2);
  assert.ok(rows[0].stay.startsWith('停留 '));
  assert.equal(rows[1].stay, `停留 ${shared.formatDuration(logs[1].createdAt, logs[0].createdAt)}`);
});
// Execute the actual React timeline function, replacing only JSX rendering and external formatting.
function loadTimelineTab() {
  const path = new URL('../../neighbor-web/src/components/WorkOrderSheet.tsx', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = file.statements.find(n => n.name?.text === 'TimelineTab');
  assert.ok(fn);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fn.getText(file) + '\nexports.fn = TimelineTab;', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
  }).outputText, {
    exports, React: { createElement: (tag, props, ...children) => ({ tag, props, children }) },
    sortTimelineNewestFirst: shared.sortTimelineNewestFirst,
    ACTION_LABEL: {}, formatBeijingDateTime: s => s, statusOf: s => ({ name: s }),
  });
  return exports.fn;
}
test('新Web真实TimelineTab：最新事件和当前高亮在第一项，照片/内容不丢', () => {
  const tree = loadTimelineTab()({ detail: { logs } });
  const rows = tree.children.flat();
  assert.deepEqual(Array.from(rows, r => r.props.key), [3, 2, 1]);
  assert.match(rows[0].props.className, /\bcur\b/);
  assert.doesNotMatch(rows[2].props.className, /\bcur\b/);
  assert.deepEqual(logs.map(r => r.id), [2, 1, 3]);
});
function sortedExpression(relative, input, context) {
  const path = new URL(relative, import.meta.url);
  const source = readFileSync(path, 'utf8');
  const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'sortTimelineNewestFirst' && node.arguments[0]?.getText(file) === input) expression = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(expression, `${relative}: ${input} must use display-only shared sort`);
  const exports = {};
  vm.runInNewContext(ts.transpileModule('exports.value = ' + expression.getText(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, sortTimelineNewestFirst: shared.sortTimelineNewestFirst, ...context });
  return exports.value;
}
for (const [relative, input, context] of [
  ['../../admin-web/src/pages/WorkOrdersPage.tsx', 'detail?.logs', { detail: { logs } }],
  ['../../neighbor-web/src/pages/ResidentialBills.tsx', 'record?.timeline', { record: { timeline: logs } }],
  ['../../neighbor-web/src/pages/ResidentialBills.tsx', 'record?.prints', { record: { prints: logs.map(r => ({ ...r, printedAt: r.createdAt })) } }],
  ['../../neighbor-web/src/components/CollectionFollowups.tsx', 'events', { events: logs }],
]) {
  test(`正式Web历史排序契约：${relative} ${input}`, () => {
    const rows = sortedExpression(relative, input, context);
    assert.deepEqual(Array.from(rows, r => r.id), [3, 2, 1]);
    assert.deepEqual(logs.map(r => r.id), [2, 1, 3]);
  });
}
test('旧Web亲情车实际处理历史按at稳定倒序，不翻转原日志', () => {
  const log = Object.freeze(logs.map(r => Object.freeze({ at: r.createdAt, action: r.note })));
  const rows = sortedExpression('../../admin-web/src/pages/FamilyCarsPage.tsx', 'car.log', { car: { log } });
  assert.deepEqual(Array.from(rows, r => r.action), ['最新', '中间', '最早']);
  assert.equal(log[0].action, '中间');
});
for (const [relative, input, name] of [
  ['../../neighbor-web/src/pages/FamilyCars.tsx', 'open.log', '新Web亲情车'],
  ['../../neighbor-web/src/components/cashier/NewPlateCard.tsx', 'it.log', '资料审核'],
]) {
  test(`${name}真实审核历史统一按时刻倒序，不依赖API原序`, () => {
    const log = Object.freeze(logs.map(r => Object.freeze({ at: r.createdAt, action: r.note })));
    const rows = sortedExpression(relative, input, { open: { log }, it: { log } });
    assert.deepEqual(Array.from(rows, r => r.action), ['最新', '中间', '最早']);
  });
}
for (const [name, expectedCount] of [['RenewSheet', 1], ['RebindGarageSheets', 2], ['OtherOpSheets', 2], ['HistoryAndOwnerSheets', 1]]) {
  test(`执行过程日志${name}仅反转渲染copy，不反转存储/调用顺序`, () => {
    const path = new URL(`../../neighbor-web/src/components/vehicle-ops/${name}.tsx`, import.meta.url);
    const source = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const renderInputs = [];
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
        const input = node.expression.expression.getText(file);
        if (input === 'log' || input.includes('...log')) renderInputs.push(input);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    assert.equal(renderInputs.length, expectedCount);
    for (const input of renderInputs) {
      assert.equal(input, '[...log].reverse()');
      const log = Object.freeze(['开始', '执行中', '最新结果']);
      const rows = vm.runInNewContext(input, { log });
      assert.deepEqual(Array.from(rows), ['最新结果', '执行中', '开始']);
      assert.deepEqual(log, ['开始', '执行中', '最新结果']);
    }
    assert.doesNotMatch(source, /(?<!\.)\blog\.reverse\(/);
  });
}
test('共用小程序时间线：无效时间置底且不伪造停留，相同时刻同id稳定，finished不续计', () => {
  const source = Object.freeze([
    Object.freeze({ id: 2, createdAt: '2026-11-16T02:00:00Z', note: 'first tie', toStatus: 'done' }),
    Object.freeze({ id: 2, createdAt: '2026-11-16T02:00:00Z', note: 'second tie', toStatus: 'done' }),
    Object.freeze({ id: 1, createdAt: '2026-11-16T02:00:00Z', note: 'earlier id', toStatus: 'working' }),
    Object.freeze({ id: 9, createdAt: 'invalid', note: 'bad', toStatus: 'created' }),
    Object.freeze({ id: 10, createdAt: '', note: 'missing', toStatus: 'created' }),
  ]);
  const rows = buildTimeline(source, labels, { finished: true });
  assert.deepEqual(Array.from(rows, r => r.note), ['first tie', 'second tie', 'earlier id', 'bad', 'missing']);
  assert.equal(rows[0].stay, '');
  assert.equal(rows[3].stay, '');
  assert.equal(rows[4].stay, '');
  assert.deepEqual(Array.from(buildTimeline([], labels)), []);
});
test('两个小程序正式入口都使用共用buildTimeline，不重复翻转', () => {
  for (const app of ['miniapp-staff', 'miniapp-owner']) {
    const text = readFileSync(new URL(`../../${app}/miniprogram/pages/order-detail/order-detail.ts`, import.meta.url), 'utf8');
    assert.match(text, /timeline: buildTimeline\(detail\.logs/);
    assert.doesNotMatch(text, /buildTimeline\([^\n]+\.reverse\(/);
  }
});
