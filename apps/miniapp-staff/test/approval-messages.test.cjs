const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const file = path.resolve(__dirname, '../miniprogram/pages/messages/messages.ts');
const script = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
test('各类审批通知改走原生审批中心，旧Web路径与前导斜杠不会产生无效页面', async () => {
  let config; const routes = [], reads = [];
  const keys = ['transfer_pending_review', 'family_car_pending_manager', 'purchase_pending_office', 'purchase_pending_manager', 'purchase_pending_purchaser', 'business.review_requested', 'vehicle_intake.submitted'];
  vm.runInNewContext(script, {
    exports: {}, Page: p => { config = p; }, getApp: () => ({ getToken: () => 'synthetic' }),
    wx: { navigateTo: o => routes.push(o.url), showToast() {} },
    require(name) {
      if (name === '@pms/api-client') return { notifications: { list: async () => [...keys.map((eventKey, i) => ({ id: i + 1, eventKey, createdAt: '2026-11-18', payload: { page: '/plates' } })), { id: 10, eventKey: 'order_assigned', readAt: '2026-11-18', payload: { page: '/pages/order-detail/order-detail?id=10' } }], markRead: async id => reads.push(id) } };
      if (name === '@pms/shared-types') return { classifyNotification: () => ({ category: 'approval', priority: 'normal' }), formatDateTimeCn: String, notificationDescription: () => '' };
      if (name.endsWith('/guide')) return { guideHandlers: () => ({}) };
      if (name.endsWith('/unread')) return { refreshUnread() {} };
      return {};
    },
  });
  const page = { ...config, data: { ...config.data }, setData(p) { Object.assign(this.data, p); } };
  await page.load();
  assert.equal(page.data.list.length, 8);
  for (let index = 0; index < 8; index++) await page.onTapItem({ currentTarget: { dataset: { index } } });
  const cats = ['transfer', 'family', 'summary', 'purchase', 'purchase', 'business', 'vehicle'];
  for (let i = 0; i < 7; i++) assert.equal(routes[i], `/pages/approvals/approvals?category=${cats[i]}`);
  assert.equal(routes[7], '/pages/order-detail/order-detail?id=10');
  assert.equal(reads.length, 7);
});
