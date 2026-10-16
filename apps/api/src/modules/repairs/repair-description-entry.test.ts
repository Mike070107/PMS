import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as shared from '../../../../../packages/shared-types/src';

// Run the actual miniapp page handler with only network and platform APIs replaced.
function pageFor(app: string, result: any, entry = 'repair-create') {
  const source = readFileSync(resolve(process.cwd(), `../${app}/miniprogram/pages/${entry}/${entry}.ts`), 'utf8');
  let page: any;
  const empty = new Proxy({}, { get: () => () => [] });
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText, {
    exports: {}, Page: (definition: any) => { page = definition; },
    wx: { showToast() {} }, setTimeout: () => 0,
    requirePlugin: () => { throw new Error('no recorder in unit test'); },
    require: (name: string) => name === '@pms/shared-types' ? shared
      : name === '@pms/api-client' ? { repairs: {
        create: async (data: any) => { page.submitted = data; return { workOrder: { id: 1 } }; },
        buildRepairAiAssist: () => undefined,
      } }
      : name.endsWith('/address-detect') ? { detectRepairAddress: async () => result, shouldDetectAddress: () => false, composeDetectedAddress: () => '一期17号201' }
        : empty,
  });
  page.setData = (patch: any) => Object.assign(page.data, patch);
  return page;
}

for (const app of ['miniapp-staff', 'miniapp-owner']) {
  test(`${app}：语音/随手拍实际提交载荷不再采用含重复门牌的 AI 描述`, async () => {
    const page = pageFor(app, null, 'quick-repair');
    page.data.content = '一期17号201厨房水龙头漏水';
    page.data.detected = {
      matched: true, communityId: 1, matchedRaw: '一期17号201',
      ai: { description: '一期17号201厨房水龙头漏水' },
    };
    if (app === 'miniapp-staff') page.refreshFound();
    else page.place = { communityId: 1 };
    await page.onSubmit();
    assert.equal(page.submitted.content, '厨房水龙头漏水');
    assert.equal(page.submitted.communityId, 1);
  });
}

for (const app of ['miniapp-staff', 'miniapp-owner']) {
  test(`${app}：识别并填入地址后，描述框立即只留具体位置和故障`, async () => {
    const raw = '枫桦景苑一期17号201厨房水龙头漏水';
    const detected = { matched: true, communityId: 1, matchedRaw: '枫桦景苑一期17号201', matchedText: '一期17号201室' };
    const page = pageFor(app, detected);
    page.data.content = raw;
    await page.detectAddress(raw);
    assert.equal(page.data.detected, detected);
    assert.equal(page.data.content, '厨房水龙头漏水');
    page.refreshUrgency = () => {};
    page.autoFillFromText = () => {};
    page.scheduleDetect('厨房水龙头还在漏水');
    assert.equal(page.data.detected, detected, '补充故障时保留已填地址');
  });

  test(`${app}：只说地址时描述留空，要求补充故障，不把地址放回描述`, async () => {
    const raw = '一期17号201';
    const page = pageFor(app, { matched: true, communityId: 1, matchedRaw: raw });
    page.data.content = raw;
    await page.detectAddress(raw);
    assert.equal(page.data.content, '');
  });

  test(`${app}：未匹配地址或识别返回前已修改文字时，不删地址、不覆盖新输入`, async () => {
    const raw = '一期17号201厨房水龙头漏水';
    const page = pageFor(app, { matched: false, matchedRaw: '一期17号201' });
    page.data.content = raw;
    await page.detectAddress(raw);
    assert.equal(page.data.content, raw);
    page.data.content = '电梯口照明不亮';
    await page.detectAddress(raw);
    assert.equal(page.data.content, '电梯口照明不亮');
  });
}
