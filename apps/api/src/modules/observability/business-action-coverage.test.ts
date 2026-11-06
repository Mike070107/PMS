import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBusinessAction } from './business-action';
import { businessActionCodesByArea, listBusinessActions } from './business-action';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { LEGACY_ACTION_CODES } from './business-action-compatibility-fixture';

function controllerWrites() {
  const routes: Array<{ method: string; path: string }> = [];
  const visitDir = (dir: string) => {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, file.name);
      if (file.isDirectory()) { visitDir(path); continue; }
      if (!file.name.endsWith('.controller.ts')) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const decorators = (node: ts.Node) => ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
      const call = (d: ts.Decorator) => ts.isCallExpression(d.expression) ? d.expression : undefined;
      const name = (c: ts.CallExpression) => c.expression.getText(source);
      const value = (c: ts.CallExpression) => {
        const arg = c.arguments[0];
        assert.ok(!arg || ts.isStringLiteral(arg), `路由参数需要明确提取: ${path}`);
        return arg && ts.isStringLiteral(arg) ? arg.text : '';
      };
      for (const node of source.statements) {
        if (!ts.isClassDeclaration(node)) continue;
        const controller = decorators(node).map(call).find((c) => c && name(c) === 'Controller');
        if (!controller) continue;
        for (const member of node.members) {
          for (const d of decorators(member)) {
            const c = call(d);
            if (!c || !['Post', 'Patch', 'Put', 'Delete'].includes(name(c))) continue;
            routes.push({ method: name(c).toUpperCase(), path: '/' + [value(controller), value(c)].filter(Boolean).join('/') });
          }
        }
      }
    }
  };
  visitDir(resolve(__dirname, '..'));
  return routes;
}

test('所有 Controller 写接口均有明确中文业务动作及筛选模块（保留历史口径并覆盖新增MIS）', () => {
  const routes = controllerWrites();
  const added=[['POST','/fees/mis/postings'],['POST','/fees/mis/postings/:id/retry']];
  assert.equal(routes.length, LEGACY_ACTION_CODES.length+added.length);
  assert.deepEqual(new Set(routes.map((r) => `${r.method} ${r.path}`)), new Set([...LEGACY_ACTION_CODES,...added].map(([m, p]) => `${m} ${p}`)));
  const issues: string[] = [];
  for (const route of routes) {
    const path = route.path.replace(/:[^/]+/g, '31');
    const action = resolveBusinessAction(route.method, path);
    if (!action.known || /新增\/提交|未标注|^(新增|提交|修改|删除)(业务|账号|附件)$/.test(action.label)) issues.push(`${route.method} ${route.path}: ${action.label}`);
    assert.match(action.label, /[\u4e00-\u9fff]/);
    assert.match(action.area, /[\u4e00-\u9fff]/);
    if (action.known) {
      assert.ok(businessActionCodesByArea(action.area).includes(action.code));
      assert.ok(listBusinessActions().some((g) => g.area === action.area && g.actions.some((a) => a.code === action.code && a.label === action.label)));
    }
  }
  assert.deepEqual(issues, []);
});

test('保留既有129规则和新增164条的历史 code（敏感参数固定模板名）', () => {
  for (const [method, template, oldCode] of LEGACY_ACTION_CODES) {
    const path = template.replace(/:[^/]+/g, '31');
    const expected = template.includes(':token') ? oldCode.replace(/_id$/, '_token') : template.includes(':pluginSecret') ? oldCode.replace(/_id$/, '_pluginSecret') : oldCode;
    assert.equal(resolveBusinessAction(method, path).code, expected, `${method} ${template}`);
  }
});

test('扫码授权、登录、刷新、主题和本人资料分开，不把授权说成建账号', () => {
  const expected: Record<string, string> = {
    'qr-login/scan': '扫码查看网页登录请求', 'qr-login/confirm': '确认网页登录授权',
    'qr-login/cancel': '取消网页登录授权', 'admin-login': '管理员登录',
    'staff-login': '员工登录', 'wx-login': '微信登录', 'refresh': '刷新登录状态',
    'self-profile': '修改本人资料',
  };
  for (const [path, label] of Object.entries(expected)) assert.equal(resolveBusinessAction('POST', `/auth/${path}`).label, label);
  assert.equal(resolveBusinessAction('PATCH', '/auth/ui-preferences', { theme: 'dark' }).label, '切换主题或调整界面偏好');
});

test('敏感路由和详情不采集票据、密钥、密码、手机号、表单原文或任意用户标签', () => {
  const secret = 'VERY-SENSITIVE-credential';
  const body = { ticket: secret, token: secret, password: secret, phone: secret, phoneCode: secret, content: secret, label: secret, actionLabel: secret };
  for (const path of [`/vehicle-intake-form/${secret}`, `/external-access-agent/frp-plugin/${secret}`, '/auth/qr-login/scan', '/auth/self-profile', '/upload']) {
    const action = resolveBusinessAction('POST', path, body, body);
    assert.equal(action.known, true);
    assert.ok(!JSON.stringify(action).includes(secret));
    assert.deepEqual(action.detail, {});
  }
});

test('未知写接口保持中性且显式标记未标注', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const action = resolveBusinessAction(method, '/future-widget/31/activate');
    assert.equal((action as any).known, false);
    assert.equal(action.label, '提交业务请求（业务动作未标注）');
    assert.equal(action.code, `${method.toLowerCase()}_future_widget_id_activate`);
    assert.notEqual(action.code, resolveBusinessAction(method, '/future-widget/31/deactivate').code);
  }
});

test('审核措辞不由方法猜通过，打印仅记录请求且扩展规则保留业务对象索引', () => {
  for (const path of ['/audits/31/approve', '/audits/31/reject', '/transfer-orders/31/approve', '/transfer-orders/31/reject', '/purchase-requests/31/reject', '/purchase-requests/31/manager-approve', '/purchase-requests/31/reject-item']) {
    assert.match(resolveBusinessAction('POST', path).label, /^审核/);
  }
  assert.equal(resolveBusinessAction('POST', '/fees/cashier/receipts/SJ31/reprint').label, '请求补打公寓收费小票');
  assert.equal(resolveBusinessAction('DELETE', '/maintenance-orders/31').label, '作废计划维保单');
  assert.equal(resolveBusinessAction('PATCH', '/family-cars/31').objectId, 31);
  assert.equal(resolveBusinessAction('POST', '/vehicle-intake-form/123456').objectId, undefined);
});

test('既有规则和 AI 报修分支显式已标注', () => {
  for (const path of ['/repair-requests', '/work-orders/31/assign']) {
    assert.equal((resolveBusinessAction('POST', path) as any).known, true);
  }
});
