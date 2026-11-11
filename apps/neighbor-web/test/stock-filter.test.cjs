const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('后台库存默认有货，开关可恢复零库存，导出传递相同筛选', async () => {
  const states = [];
  let cursor = 0;
  let exported = '';
  const fixtures = [
    [{ id: 1, materialId: 1, warehouseId: 2, qty: '0.00', safetyQty: 1 }, { id: 2, materialId: 2, warehouseId: 2, qty: '3.00', safetyQty: 0 }],
    [{ id: 1, name: '电子浮球阀', unit: '只' }, { id: 2, name: '电源', unit: '个' }],
    [{ id: 2, name: '智能化维修工仓库' }],
  ];
  const hooks = {
    useState(init) { const index = cursor++; if (!(index in states)) states[index] = index < 3 ? fixtures[index] : init; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {},
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.resolve(__dirname, '../src/pages/Stock.tsx'), 'utf8').replaceAll('import.meta.env.BASE_URL', "'/'");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, URLSearchParams, setTimeout,
    fetch: async url => { exported = url; throw Error('仅捕获导出请求'); },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return require(name);
      if (name === '@/lib/auth') return { auth: { getToken: () => '', getActingTenant: () => null } };
      if (name === '@/lib/api') return { apiBaseURL: '/api/v1' };
      if (name === '@/lib/perm') return { can: () => false };
      if (name === '@/lib/format') return { money: String, dayjs: () => ({ format: () => '' }) };
      if (name === '@/components/ui') return { Card: 'section', Sheet: 'section', Btn: 'button', toast() {} };
      if (name === '@/components/Icon' || name === '@/components/ToneIcon' || name === '@/components/stock/WarehouseManager') return { __esModule: true, default: 'span' };
      return {};
    },
  });
  function render() { cursor = 0; return module.exports.default(); }
  function all(node, predicate) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(child => all(child, predicate));
    return [...(predicate(node) ? [node] : []), ...all(node.props?.children, predicate)];
  }
  const stockRows = tree => all(tree, n => n.type === 'tr' && n.props.className === 'row');
  let tree = render();
  assert.equal(stockRows(tree).length, 1);
  const toggle = () => all(tree, n => n.type === 'button' && n.props.children === '仅显示有货')[0].props.onClick();
  toggle(); tree = render();
  assert.equal(stockRows(tree).length, 2);
  toggle(); tree = render();
  assert.equal(stockRows(tree).length, 1);
  all(tree, n => n.type === 'button' && Array.isArray(n.props.children) && n.props.children.includes('导出 Excel'))[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(exported, /onlyStocked=1/);
});
