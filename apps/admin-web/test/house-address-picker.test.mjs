import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the real component's event handlers and rendered Cascader props.
const source = readFileSync(new URL('../src/components/HouseAddressPicker.tsx', import.meta.url), 'utf8');
function mount(initialProps = {}) {
  const states = [];
  let cursor = 0;
  const exports = {};
  const shared = {
    communityMatchKeys: () => ({}), buildingMatchKeys: () => ({}), houseMatchKeys: () => ({ room: true }),
    formatBuildingLabel: (_, b) => b.name, formatBuildingFull: b => b.name,
    formatFullAddress: (c, b, room) => [c, b?.name, room].filter(Boolean).join('/'),
    tokenizeAddress: text => [text], scoreAddressPath: (_, path) => path.at(-1).room ? 10 : 0,
  };
  const hooks = {
    useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState: initial => {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = value; }];
    },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, require: name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'antd') return { Cascader: 'Cascader', Typography: { Text: 'Text' } };
    if (name === '@pms/shared-types') return shared;
    if (name.endsWith('.css')) return {};
    throw new Error(name);
  } });
  let props = { communities: [{ id: 1, name: '测试小区', buildings: [{ id: 2, name: '4号', houses: [{ id: 3, roomNo: '201' }] }] }], ...initialProps };
  return {
    render(next = {}) {
      props = { ...props, ...next };
      cursor = 0;
      return exports.default(props).props.children[0].props;
    },
  };
}

function roomPath(control) {
  const community = control.options[0];
  const building = community.children[0];
  return [community, building, building.children[1]];
}

test('未传 value 的更正地址入口，点选房号后保留完整地址，清空同步回调', () => {
  let picked;
  const component = mount({ onPicked: value => { picked = value; } });
  let control = component.render();
  control.onChange([1, 2, 3], roomPath(control));
  control = component.render();
  assert.equal(control.displayRender(), '测试小区/4号/201');
  assert.equal(picked.houseId, 3);
  control.onChange([], []);
  control = component.render();
  assert.equal(control.displayRender(), '');
  assert.equal(picked, null);
});

test('搜索后直接回车同样回填地址', () => {
  const component = mount();
  component.render().onSearch('201');
  component.render().onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(component.render().displayRender(), '测试小区/4号/201');
});

test('表单和门禁受控入口以外部 value 为准，支持更新和重置', () => {
  let changed;
  const component = mount({ value: [], onChange: value => { changed = value; } });
  let control = component.render();
  control.onChange([1, 2, 3], roomPath(control));
  assert.equal(component.render().displayRender(), '');
  assert.deepEqual(Array.from(changed), [1, 2, 3]);
  assert.equal(component.render({ value: changed }).displayRender(), '测试小区/4号/201');
  assert.equal(component.render({ value: undefined }).displayRender(), '');
});
