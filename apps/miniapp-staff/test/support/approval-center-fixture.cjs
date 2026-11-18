const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../node_modules/typescript');
const sourcePath = path.resolve(__dirname, '../../miniprogram/pages/approvals/approvals.ts');
const script = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const response = (rows = [], patch = {}) => ({ rows, categories: ['purchase', 'summary', 'transfer', 'family', 'familyOffice', 'vehicle', 'business', 'stocktake', 'maintenance'].map((key, i) => ({ key, label: ['采购审批', '采购汇总', '库存调拨', '亲情车经理', '亲情车资料', '车辆登记', '收费特批', '盘点复核', '养护签字'][i], count: rows.filter(r => r.category === key).length })), tabs: { pending: rows.length, done: 0 }, allCount: rows.length, total: rows.length, page: 1, hasMore: false, ...patch });
function fixture(options = {}) {
  let config, mode = 'approvals';
  const calls = [], dialogs = [], toasts = [], badges = [], routes = [];
  const client = {
    approvals: { list: async q => { calls.push(['list', q]); return options.list ? options.list(q) : response(); }, decide: async (...args) => { calls.push(['decide', ...args]); if (options.decide) return options.decide(...args); } },
    maintenance: { signTasks: async () => options.signs || [] },
    purchases: Object.fromEntries(['managerApprove', 'purchaserApprove', 'reject', 'rejectItem'].map(key => [key, async (...args) => calls.push([key, ...args])])),
    familyCars: { managerReview: async (...args) => calls.push(['family', ...args]) },
  };
  const wx = { showModal: async o => { dialogs.push(o); return options.modal ? options.modal(o) : { confirm: true, content: '' }; }, showToast: o => toasts.push(o), setNavigationBarTitle() {}, navigateTo: o => routes.push(o.url), downloadFile: o => o.success({ statusCode: 200, tempFilePath: 'synthetic.pdf' }), openDocument: async () => {}, previewImage() {} };
  vm.runInNewContext(script, {
    exports: {}, wx, console, getApp: () => ({ baseURL: 'https://synthetic.invalid/api/v1' }), Page: c => { config = c; },
    require(name) {
      if (name === '@pms/api-client') return client;
      if (name === '@pms/miniapp-ui') return { formatDateTimeCn: String };
      if (name === '@pms/shared-types') return { PURCHASE_STATUS_LABELS: {}, PurchaseRequestStatus: { PURCHASER_REVIEW: 'purchaser_review' } };
      if (name.endsWith('/session')) return { getSession: async () => ({ canSignMaintenance: true, canInspectMaintenance: true }) };
      if (name.endsWith('/tabbar')) return { cachedApprovalMode: () => mode, rememberApprovalMode: m => { mode = m; }, setTabBadge: (...a) => badges.push(a.slice(1)), syncTabBar() {} };
      if (name.endsWith('/badges')) return { refreshTabBadges() {} };
      if (name.endsWith('/guide')) return { guideHandlers: () => ({ syncGuide() {} }) };
      return {};
    },
  }, { filename: sourcePath });
  const page = { ...config, data: JSON.parse(JSON.stringify(config.data)), setData(p) { Object.assign(this.data, p); } };
  return { page, calls, dialogs, toasts, badges, routes, setMode(m) { mode = m; } };
}
const tap = dataset => ({ currentTarget: { dataset } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
module.exports = { fixture, response, tap, tick, deferred };
