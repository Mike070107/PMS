// Read-only source isolation: real TS/TSX + JSX, no API/DB, no browser/E2E claim.
// 采购流程审批环节「导出 Excel」回归：
//   1) 申请 → 申购单字段映射（含驳回行剔除、来源工单、照片、管理处抬头）
//   2) 审批环节确实有导出入口，点击后交给旧后台同一套《材料申购单》导出函数
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const nativeRequire = require;
const root = path.resolve(__dirname, '..');

function load(file, deps = {}, suffix = '') {
  const source = fs.readFileSync(file, 'utf8') + '\n' + suffix;
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    URLSearchParams,
    console,
    require(id) {
      if (id.endsWith('.css')) return {};
      if (id in deps) return deps[id];
      if (id.startsWith('.')) {
        const next = path.resolve(path.dirname(file), id);
        return load(fs.existsSync(next + '.tsx') ? next + '.tsx' : next + '.ts');
      }
      return nativeRequire(id);
    },
  }, { filename: file });
  return module.exports;
}

const dayjs = nativeRequire('dayjs');
const format = { ago: () => '刚刚', dayjs, money: (v) => `¥${Number(v || 0).toFixed(2)}` };
const hooks = {
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect() {},
};
const ui = load(path.join(root, 'src/components/ui.tsx'), { '@/lib/format': format, react: hooks });
const purchaseForm = load(path.join(root, 'src/lib/purchase-form.ts'));

const S = {
  DRAFT: 'draft', OFFICE_REVIEW: 'office_review', MANAGER_REVIEW: 'manager_review',
  PURCHASER_REVIEW: 'purchaser_review', APPROVED: 'approved', REJECTED: 'rejected',
  MERGED: 'merged', DONE: 'done',
};
const request = {
  id: 7,
  requestNo: 'PR20261106001',
  status: S.MANAGER_REVIEW,
  applicantId: 1,
  applicantName: '张三',
  officeReviewerName: '李四',
  workOrderId: null,
  workOrderNo: 'WO20261106009',
  reason: '',
  estTotalCents: 10000,
  managerId: null,
  managerAt: null,
  purchaserId: null,
  purchaserAt: null,
  createdAt: '2026-11-06T10:00:00+08:00',
  items: [
    {
      lineId: 'a', name: '阀门（口语）', materialName: '铜阀门', spec: 'DN50', qty: 2, unit: '个',
      note: '水泵房用', sourceWorkOrderNo: 'WO20261106009', photoUrls: ['/p/valve.jpg'],
    },
    { lineId: 'b', name: '已被驳回的行', qty: 1, rejectReason: '已有库存' },
  ],
};

test('真实 purchaseFormOf：抬头 / 申请人 / 日期 / 原因 / 明细按旧版申购单口径摊平', () => {
  const form = purchaseForm.purchaseFormOf(request, '枫桦景苑管理处');
  assert.equal(form.areaName, '枫桦景苑管理处');
  assert.equal(form.requestNo, 'PR20261106001');
  assert.equal(form.applicantName, '李四');
  assert.equal(form.dateText, '2026/11/6');
  assert.equal(form.reason, '来源工单 WO20261106009');
  assert.equal(form.items.length, 1, '已驳回的行不该出现在申购单上');
  assert.deepEqual(JSON.parse(JSON.stringify(form.items[0])), {
    name: '铜阀门',
    spec: 'DN50',
    qty: 2,
    unit: '个',
    note: '水泵房用',
    sourceOrderNo: 'WO20261106009',
    photoUrl: '/p/valve.jpg',
  });
});

test('真实 purchaseFormOf：有申请原因时优先用它，没有工单也可为空', () => {
  assert.equal(purchaseForm.purchaseFormOf({ ...request, reason: '补库存：公区耗材' }, '').reason, '补库存：公区耗材');
  assert.equal(purchaseForm.purchaseFormOf({ ...request, workOrderNo: null }, '').reason, '');
  assert.equal(purchaseForm.purchaseFormOf({ ...request, workOrderNo: null }, '').areaName, '');
});

function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children), ...nodes(node.props?.headExtra)];
}

function render({ stage = 'manager', detail = null, called }) {
  const session = { user: { name: '李四' }, access: { offices: [{ id: 1, name: '枫桦苑' }] }, actingOffice: { id: 1, name: '枫桦景苑管理处' } };
  const seed = [
    stage, // stage
    { [S.MANAGER_REVIEW]: [request], [S.PURCHASER_REVIEW]: [request] }, // byStatus
    [], // orders
    '', // err
    [], // checked
    false, // busy
    false, // exporting
    detail, // detail
    false, // composing
    null, // ordering
    null, // receiving
    null, // reject
    '', // reason
  ];
  let i = 0;
  const module = load(path.join(root, 'src/pages/Purchase.tsx'), {
    react: {
      useState(init) { const at = i++; return [at < seed.length ? seed[at] : typeof init === 'function' ? init() : init, () => {}]; },
      useRef: (v) => ({ current: v }),
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useEffect() {},
    },
    'react-router-dom': { useSearchParams: () => [new URLSearchParams(''), () => {}] },
    '@pms/api-client': { inventory: { listPurchaseOrders: async () => [] }, purchases: {}, request() {} },
    '@pms/shared-types': { PurchaseRequestStatus: S },
    '@legacy/lib/purchaseRequestForm': { downloadPurchaseRequestForms: async (...args) => { called.push(args); } },
    '@/components/purchase/RequestComposer': { __esModule: true, default: 'RequestComposer' },
    '@/components/Icon': { __esModule: true, default: 'Icon' },
    '@/lib/auth': { useSession: () => session },
    '@/lib/perm': { can: () => true },
    '@/lib/purchase-form': purchaseForm,
    '@/lib/format': format,
    '@/components/ui': ui,
  });
  return module.default();
}

test('真实 Purchase：经理审批 / 采购审批环节有导出入口，点击导出本环节申购单', async () => {
  for (const stage of ['manager', 'purchaser']) {
    const called = [];
    const tree = render({ stage, called });
    const buttons = nodes(tree).filter((n) => n.type === ui.Btn);
    const exportAll = buttons.find((n) => text(n).includes('导出 Excel（全部 1）'));
    assert.ok(exportAll, `${stage} 环节缺少导出全部按钮`);
    assert.equal(exportAll.props.disabled, false);
    const exportRow = buttons.find((n) => text(n) === '导出');
    assert.ok(exportRow, `${stage} 环节每行缺少导出按钮`);

    await exportAll.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called.length, 1, '点击导出应调用旧版申购单导出');
    const [forms, options] = called[0];
    assert.equal(forms.length, 1);
    assert.equal(forms[0].areaName, '枫桦景苑管理处');
    assert.equal(forms[0].requestNo, 'PR20261106001');
    assert.equal(options.fileName, undefined, '单张导出沿用旧文件名规则');
  }
});

test('真实 Purchase：审批详情抽屉也能导出当前这张', async () => {
  const called = [];
  const tree = render({ detail: request, called });
  const button = nodes(tree).find((n) => n.type === ui.Btn && text(n) === '导出 Excel');
  assert.ok(button, '详情抽屉缺少导出 Excel');
  await button.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called.length, 1);
  assert.equal(called[0][0][0].applicantName, '李四');
});
