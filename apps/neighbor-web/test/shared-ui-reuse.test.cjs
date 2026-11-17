const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function load(file, deps) {
  const module = { exports: {} };
  const code = ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: id => id in deps ? deps[id] : require(id) });
  return module.exports;
}
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };

for (const access of [null, { pages: { meters: { edit: true, delete: false } } }, { isTenantAdmin: true, pages: {} }, { isPlatformAdmin: true, pages: {} }]) {
  test(`共享抄表工作区仍从新版会话和权限适配读取：${JSON.stringify(access)}`, () => {
    const session = { user: { id: 7, tenantId: 8 }, actingTenant: { id: 9 }, access };
    const adapter = load('legacy/lib/auth.ts', { '@/lib/auth': { auth: {}, useSession: () => session } });
    const workspace = () => {}, photos = () => {}, methods = () => {};
    const page = load('legacy/pages/MeterManagementPage.tsx', {
      'react/jsx-runtime': jsx,
      '@legacy/pages/MeterManagementPage': { MeterManagementWorkspace: workspace },
      '../lib/auth': adapter,
      '../components/MaterialPhotos': { MaterialPhotosUpload: photos },
      '../components/MeterPaymentMethods': { default: methods, __esModule: true },
    }).default();
    assert.equal(page.type, workspace);
    assert.equal(page.props.session, session);
    assert.deepEqual(page.props.permissions, adapter.pagePerm(access, 'meters'));
    assert.equal(page.props.PhotoUpload, photos);
    assert.equal(page.props.PaymentMethods, methods);
    assert.equal(page.props.permissions.canEdit, !!access?.isTenantAdmin || !!access?.isPlatformAdmin || !!access?.pages?.meters?.edit);
  });
}

test('共用照片上传实现只使用新版实时 token，不能回退旧版会话', () => {
  const shared = () => {}, auth = { getToken: () => 'neighbor-current-token' };
  const component = load('legacy/components/MaterialPhotos.tsx', {
    'react/jsx-runtime': jsx,
    '@legacy/components/MaterialPhotos': { MaterialPhotosUpload: shared, MATERIAL_PHOTO_LIMIT: 4 },
    '../lib/auth': { auth },
  });
  const onChange = () => {};
  const result = component.MaterialPhotosUpload({ max: 1, compact: true, onChange });
  assert.equal(result.type, shared);
  assert.equal(result.props.getToken, auth.getToken);
  assert.equal(result.props.getToken(), 'neighbor-current-token');
  assert.equal(result.props.max, 1);
  assert.equal(result.props.onChange, onChange);
  assert.equal(component.MATERIAL_PHOTO_LIMIT, 4);
});

test('旧迁移路径和共用路径导出同一粘贴 hook，不创建第二个注册表', () => {
  const hook = () => {}, factory = () => {};
  const result = load('legacy/components/useUploadPasteTarget.ts', { '@legacy/components/useUploadPasteTarget': { useUploadPasteTarget: hook, createUploadPasteTargetRegistry: factory } });
  assert.equal(result.useUploadPasteTarget, hook);
  assert.equal(result.createUploadPasteTargetRegistry, factory);
  assert.doesNotMatch(source('legacy/components/useUploadPasteTarget.ts'), /new Set|activeId/);
});

test('模板共用视图保持新版 settings 权限；无编辑权限时不得启用写入', () => {
  const view = () => {};
  const component = load('legacy/pages/FeeTemplateSettings.tsx', { 'react/jsx-runtime': jsx, '@legacy/pages/FeeTemplateSettings': { FeeTemplateWorkspace: view }, '../lib/auth': { usePagePerm: key => { assert.equal(key, 'settings'); return { canEdit: false }; } } });
  const result = component.default();
  assert.equal(result.type, view);
  assert.equal(result.props.canEdit, false);
});

test('共用样式只引用原有规范，迁移层不得继续复制整份样式', () => {
  for (const file of ['legacy/pages/FeesReportShell.css', 'legacy/pages/MeterManagementPage.css', 'legacy/pages/FeeTemplateSettings.css', 'components/HouseAddressPicker.css']) {
    const css = source(file).trim();
    assert.match(css, /^@import\s+['"][^'"]+['"];$/);
    const target = css.match(/['"]([^'"]+)['"]/)[1];
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), target)), file);
  }
});
