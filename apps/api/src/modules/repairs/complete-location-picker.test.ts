import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as shared from '../../../../../packages/shared-types/src';

function mount() {
  const source = readFileSync(resolve(process.cwd(), '../miniapp-staff/miniprogram/pages/order-detail/order-detail.ts'), 'utf8');
  let page: any;
  const empty = new Proxy({}, { get: () => () => [] });
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, {
    exports: {}, Page: (definition: any) => { page = definition; },
    requirePlugin: () => { throw new Error('no recorder'); },
    require: (name: string) => name === '@pms/shared-types' ? shared
      : name === '@pms/api-client' ? { repairs: { complete: async (_id: string, data: unknown) => {
        page.submitted = data;
        throw new Error('test: simulate save failure');
      } } } : name.endsWith('/unread') ? { askOrderSubscribe: async () => false } : empty,
  });
  page.setData = (patch: any, done?: () => void) => { Object.assign(page.data, patch); done?.(); };
  return page;
}

test('完工位置选房号后回填原输入框，不改变原报修地址，仍可补充细节', () => {
  const page = mount();
  const detail = { request: { houseId: 10, addressText: '原报修地址' } };
  page.data.detail = detail;
  page.onCompletePlacePicked({ detail: { fullText: '枫桦景苑一期 17号 201室' } });
  assert.equal(page.data.faultLocation, '枫桦景苑一期 17号 201室');
  assert.equal(page.data.detail, detail);
  page.onFaultInput({ currentTarget: { dataset: { field: 'faultLocation' } }, detail: { value: '枫桦景苑一期 17号 201室 厨房水槽下方' } });
  assert.equal(page.data.faultLocation, '枫桦景苑一期 17号 201室 厨房水槽下方');
});

test('完工位置复用现有房产簿和点位，返回时先关选择器并保留完工草稿', async () => {
  const page = mount();
  page.addressBook = [{ id: 1 }];
  page.addressSpots = [{ id: 2 }];
  page.data.panel = 'complete';
  page.data.editBookLoading = false;
  page.data.faultLocation = '厨房';
  const calls: unknown[] = [];
  page.selectComponent = (id: string) => {
    assert.equal(id, '#completePlacePicker');
    return { setBook: (...args: unknown[]) => calls.push(args), onOpen: () => calls.push('open'), onClose: () => calls.push('close') };
  };
  await page.onOpenCompletePlace();
  assert.equal(calls[1], 'open');
  page.onCompletePickerOpenChange({ detail: { open: true } });
  page.onEdgeBack();
  assert.equal(calls[2], 'close');
  assert.equal(page.data.panel, 'complete');
  assert.equal(page.data.faultLocation, '厨房');
});

test('房产读取失败保留输入并展示可重试错误', async () => {
  const page = mount();
  page.addressBook = [];
  page.data.editBookLoading = false;
  page.data.panel = 'complete';
  page.data.faultLocation = '电梯口';
  page.loadEditBook = async () => {};
  await page.onOpenCompletePlace();
  assert.equal(page.data.faultLocation, '电梯口');
  assert.ok(page.data.completePlaceError);
});

test('完工提交载荷包含所选实际位置，保存失败保留草稿', async () => {
  const page = mount();
  const location = '枫桦景苑一期 17号 201室 厨房';
  page.onCompletePlacePicked({ detail: { fullText: location } });
  await page.onComplete();
  assert.equal(page.submitted.faultLocation, location);
  assert.equal(page.data.faultLocation, location);
  assert.match(page.data.errorMsg, /test: simulate save failure/);
});
