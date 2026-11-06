const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function transpile(source) { return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText; }
// Load the actual shared constant rather than a test-side list.
const sharedModule = { exports: {} };
vm.runInNewContext(transpile(fs.readFileSync(path.join(root, '../packages/shared-types/src/index.ts'), 'utf8')), { module: sharedModule, exports: sharedModule.exports, require() { return {}; } });
const shared = sharedModule.exports;
const text = n => n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join('') : text(n.props?.children);
function harness(initialHouse = null) {
  let cursor = 0, dirty = false, ui;
  const slots = [], effects = [], requests = [], created = [], locationCalls = [];
  const props = { open: true, initialHouse, onClose() {}, onCreated: id => created.push(id) };
  const react = {
    useState(init) { const i = cursor++; slots[i] ??= { value: typeof init === 'function' ? init() : init }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !deps.every((v, k) => Object.is(v, slots[i].deps[k]))) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(transpile(fs.readFileSync(path.join(root, 'neighbor-web/src/components/NewOrderSheet.tsx'), 'utf8')), {
    module, exports: module.exports, Error, require(id) {
      if (id === 'react') return react;
      if (id === 'react/jsx-runtime') return require(id);
      if (id === '@pms/shared-types') return shared;
      if (id === '@pms/api-client') return { repairs: { locationSuggestions: communityId => new Promise((resolve,reject)=>locationCalls.push({communityId,resolve,reject})), create: payload => new Promise((resolve, reject) => requests.push({ payload, resolve, reject })) } };
      if (id === '@/lib/address-tree') return { useAddressTree: () => ({ communities: [{ id: 21 }], error: '' }) };
      if (id === '@/components/ui') return { Field: 'Field', Sheet: 'Sheet', Btn: 'Btn', ErrorNote: 'ErrorNote', toast() {} };
      if (id.endsWith('.css')) return {};
      if (id === '@/components/LocationSuggestions') return { __esModule: true, default: 'LocationSuggestions' };
      if (id === '@/lib/repair-location-options') { const m={exports:{}};vm.runInNewContext(transpile(fs.readFileSync(path.join(root,'neighbor-web/src/lib/repair-location-options.ts'),'utf8')),{module:m,exports:m.exports});return m.exports; }
      if (id === '@/components/HousePicker') return { __esModule: true, default: 'HousePicker' };
      if (id === '@/components/Icon') return { __esModule: true, default: 'Icon' };
      throw Error('Unexpected import: ' + id);
    },
  });
  function render() { let count = 0; do { dirty = false; cursor = 0; ui = module.exports.default(props); while (effects.length) effects.shift()(); assert.ok(++count < 30); } while (dirty); return ui; }
  function nodes(n = ui) { return !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...(n.props?.children === undefined ? [] : nodes(n.props.children))]; }
  function find(type, predicate = () => true) { const n = nodes().find(n => n.type === type && predicate(n)); assert.ok(n, 'missing ' + type); return n; }
  const field = label => find('Field', n => n.props.label.replace(/ \*$/, '') === label);
  const input = label => nodes(field(label)).find(n => n.type === 'input' || n.type === 'textarea');
  const change = (label, value) => { input(label).props.onChange({ target: { value } }); render(); };
  const click = label => { const options=nodes().find(n=>n.type==='LocationSuggestions'); if (options?.props.options.some(x=>x.text===label)) options.props.onSelect(label); else find('button', n => text(n) === label).props.onClick(); render(); };
  render();
  return { props, requests, locationCalls, created, render, nodes, find, field, input, change, click, async settle() { await new Promise(r => setImmediate(r)); render(); } };
}
const house = { communityId: 21, text: '枫桦二期 228弄3号502室', houseId: 501, ownerName: '张女士', ownerPhone: '13800000000' };
const publicArea = { locationKind: 'public', communityId: 22, communityName: '测试一期', buildingId: 205, fullText: '测试一期/198弄5号/公共区域' };
const prefill = { communityId: 21, addressText: house.text, contactName: house.ownerName, contactPhone: house.ownerPhone };

test('换住户、清除选房和切换地址方式不会残留上一处具体位置', () => {
  const h = harness();
  const pick = p => { h.find('HousePicker').props.onPick(p); h.render(); };
  pick(house); h.click('大门');
  pick({ ...house }); assert.equal(h.input('具体位置').props.value, '大门');
  pick({ ...house, houseId: 502, text: '228弄3号503室' });
  assert.equal(h.input('具体位置').props.value, '');
  h.click('楼道'); h.find('HousePicker').props.onClear(); h.render();
  assert.equal(h.input('具体位置').props.value, '');
  h.click('大门'); h.find('HousePicker').props.onPublicPick(publicArea); h.render(); assert.equal(h.input('具体位置').props.value, '');
  h.click('楼道'); pick(house); assert.equal(h.input('具体位置').props.value, '');
});

test('自动带出联系人电话但不覆盖手填值；改地址清除具体位置', () => {
  const h = harness(); h.change('联系人', '代报人');
  h.find('HousePicker').props.onPick(house); h.render();
  assert.equal(h.input('联系人').props.value, '代报人'); assert.equal(h.input('手机号').props.value, house.ownerPhone);
  h.change('手机号', '13900000000'); h.find('HousePicker').props.onPick({ ...house, houseId: 502 }); h.render();
  assert.equal(h.input('手机号').props.value, '13900000000');
  const fixed = harness(prefill); fixed.click('大门'); fixed.click('改地址');
  assert.equal(fixed.input('具体位置').props.value, ''); fixed.find('HousePicker');
});

test('清空和重新打开重置草稿，重新打开仍按传入住户带出联系人', () => {
  const h = harness(prefill); h.click('大门'); h.change('问题描述', '漏水'); h.click('紧急 · 2 小时内');
  h.find('Btn', n => text(n) === '清空').props.onClick(); h.render();
  for (const label of ['联系人', '手机号', '具体位置', '问题描述']) assert.equal(h.input(label).props.value, '');
  h.change('问题描述', '新草稿'); h.props.open = false; h.render(); h.props.open = true; h.render();
  assert.equal(h.input('联系人').props.value, prefill.contactName);
  assert.equal(h.input('手机号').props.value, prefill.contactPhone);
  assert.equal(h.input('具体位置').props.value, ''); assert.equal(h.input('问题描述').props.value, '');
});

test('失败保留输入并解除忙状态，重试成功走原API载荷与onCreated', async () => {
  const h = harness(prefill); h.click('大门'); h.change('问题描述', '窗户漏水'); h.click('紧急 · 2 小时内');
  const type = shared.REPAIR_TYPE_OPTIONS[0]; h.click(type.label); h.click('提交报修');
  assert.equal(h.find('Btn').props.disabled, true);
  h.requests[0].reject(new Error('网络失败')); await h.settle();
  assert.equal(text(h.find('ErrorNote')), '网络失败');
  assert.equal(h.input('具体位置').props.value, '大门'); assert.equal(h.input('问题描述').props.value, '窗户漏水');
  assert.equal(h.input('联系人').props.value, prefill.contactName);
  assert.equal(h.find('button', n => text(n) === '提交报修').props.disabled, false);
  h.click('提交报修'); const payload = h.requests[1].payload;
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { communityId: 21, addressText: house.text + ' 大门', contactName: prefill.contactName, contactPhone: prefill.contactPhone, locationText: '大门', repairType: type.value, content: '窗户漏水', urgent: true });
  h.requests[1].resolve({ workOrder: { id: 71 } }); await h.settle(); assert.deepEqual(h.created, [71]);
  assert.equal(h.input('问题描述').props.value, ''); assert.equal(h.input('具体位置').props.value, '');
});

test('真实JSX字段顺序：先地址再联系人，最后问题与补充信息', () => {
  const h = harness();
  assert.deepEqual(h.nodes().filter(n => n.type === 'Field').map(n => n.props.label.replace(/ \*$/, '')), ['报修位置', '具体位置', '联系人', '手机号', '问题描述', '报修类型', '紧急程度']);
  const row = h.nodes().find(n => n.props?.className === 'new-order-contact');
  assert.ok(row); assert.equal(h.nodes(row).filter(n => n.type === 'Field').length, 2);
});
test('切换住户更新自动联系人，公共区域清除自动值但保护手填', () => {
 const h=harness(); h.find('HousePicker').props.onPick(house);h.render();
 h.find('HousePicker').props.onPick({...house,houseId:502,ownerName:'李女士',ownerPhone:'13900000000'});h.render();
 assert.equal(h.input('联系人').props.value,'李女士');assert.equal(h.input('手机号').props.value,'13900000000');
 h.change('联系人','代报人'); h.find('HousePicker').props.onPublicPick(publicArea);h.render();
 assert.equal(h.input('联系人').props.value,'代报人');assert.equal(h.input('手机号').props.value,'');
 assert.equal(h.find('HousePicker').props.allowPublicArea,true);
 assert.equal(h.find('HousePicker').props.publicValue.communityId,22);
});
test('切回小区或楼栋半选后不得继续提交旧地址',()=>{
 const h=harness();h.find('HousePicker').props.onPick(house);h.render();h.change('问题描述','示例问题');
 h.find('HousePicker').props.onIncomplete();h.render();h.click('提交报修');
 assert.equal(h.requests.length,0);assert.match(text(h.find('ErrorNote')),/地址|楼栋|房号/);
});
test('清空草稿主动重置半选级联路径，而非保留已展开的旧小区',()=>{
 const h=harness();const before=h.find('HousePicker').props.selectionRevision;
 h.find('HousePicker').props.onIncomplete();h.render();assert.equal(h.find('HousePicker').props.selectionRevision,before);
 h.find('Btn',n=>text(n)==='清空').props.onClick();h.render();assert.ok(h.find('HousePicker').props.selectionRevision>before);
});
test('按所选小区加载累计常用位置，旧小区迟到结果不得串入新小区', async()=>{
 const h=harness();h.find('HousePicker').props.onPick(house);h.render();
 assert.equal(h.locationCalls[0].communityId,21);
 h.find('HousePicker').props.onPublicPick(publicArea);h.render();assert.equal(h.locationCalls[1].communityId,22);
 h.locationCalls[1].resolve({items:[{text:'示例新位置',count:4}]});await h.settle();
 assert.equal(h.find('LocationSuggestions').props.options[0].text,'示例新位置');
 h.locationCalls[0].resolve({items:[{text:'旧小区位置',count:99}]});await h.settle();
 assert.equal(h.find('LocationSuggestions').props.options[0].text,'示例新位置');
});
test('三个模式均可点常用位置，选中态清楚且可手写修改，不覆盖主地址', () => {
  for (const mode of ['fixed', 'house', 'area']) {
    const h = harness(mode === 'fixed' ? prefill : null);
    if (mode === 'house') { h.find('HousePicker').props.onPick(house); h.render(); }
    if (mode === 'area') { h.find('HousePicker').props.onPublicPick(publicArea); h.render(); }
    for (const value of shared.DEFAULT_LOCATION_SUGGESTIONS) assert.ok(h.find('LocationSuggestions').props.options.some(item=>item.text===value));
    h.click('大门'); assert.equal(h.input('具体位置').props.value, '大门');
    assert.equal(h.find('LocationSuggestions').props.value,'大门');
    h.change('具体位置', ' 厨房窗边 '); assert.notEqual(h.find('LocationSuggestions').props.value,'大门');
    h.change('问题描述', ' 窗户漏水 '); h.click('提交报修');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].payload.addressText, (mode === 'area' ? publicArea.fullText : house.text) + ' 厨房窗边');
    assert.equal(h.requests[0].payload.content, '窗户漏水');
    assert.equal(h.requests[0].payload.communityId, mode === 'area' ? 22 : 21);
    assert.equal(h.find('button', n => text(n) === '提交中…').props.disabled, true);
  }
});
