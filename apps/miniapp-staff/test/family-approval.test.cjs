const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../package.json'));
const ts = req('typescript');
const root = path.resolve(__dirname, '../miniprogram');
const sourcePath = path.join(root, 'pages/approvals/approvals.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const script = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const tap = { currentTarget: { dataset: { id: 73, plate: '苏FM05P3' } } };

// Only synthetic records/transport. Never connect to PMS or approve a real car.
function fixture({ confirm = true, modalError, reviewError, modalWait, reviewWait, reason = '' } = {}) {
  let config;
  const dialogs = [], reviews = [], toasts = [];
  let refreshes = 0;
  const wx = {
    async showModal(options) {
      dialogs.push(options);
      // Installed miniprogram-api-typings ShowModalOption: max 4 characters.
      for (const key of ['confirmText', 'cancelText']) {
        if (options[key] && Array.from(options[key]).length > 4) {
          throw { errMsg: `showModal:fail ${key} length should not be larger than 4` };
        }
      }
      if (modalError) throw modalError;
      if (modalWait) await modalWait;
      return { confirm, cancel: !confirm, content: reason };
    },
    showToast: (options) => toasts.push(options),
  };
  const client = {
    familyCars: {
      async managerReview(...args) {
        reviews.push(args);
        if (reviewWait) await reviewWait;
        if (reviewError) throw reviewError;
      },
    },
  };
  const exposed = {};
  vm.runInNewContext(script + '\nexports.toFamilyRow = toFamilyRow;', {
    exports: exposed, wx, console, getApp: () => ({ baseURL: 'https://synthetic.invalid/api/v1' }), Page: (options) => { config = options; },
    require(name) {
      if (name === '@pms/api-client') return client;
      if (name === '@pms/miniapp-ui') return { formatDateTimeCn: String };
      if (name.endsWith('/guide')) return { guideHandlers: () => ({}) };
      return {};
    },
  }, { filename: sourcePath });
  const row = { id: 73, plate: '苏FM05P3', files: [{ fileName: 'synthetic.png' }] };
  const page = {
    ...config, data: { ...config.data, canApproveFamilyCar: true, familyList: [row] },
    setData(patch) { Object.assign(this.data, patch); },
    async load() { refreshes++; this.data.familyList = []; },
  };
  return { page, dialogs, reviews, toasts, toFamilyRow: exposed.toFamilyRow, get refreshes() { return refreshes; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('苏FM05P3模拟待审：确认弹窗合法、只提交一次approve并刷新列表', async () => {
  const f = fixture();
  await f.page.onApproveFamily(tap);
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].title, /苏FM05P3/);
  assert.equal(f.dialogs[0].confirmText, '确认通过');
  assert.match(f.dialogs[0].content, /申请期限：12个月/);
  assert.doesNotMatch(f.dialogs[0].content, /从今天|续期一年/);
  assert.deepEqual(f.reviews, [[73, 'approve']]);
  assert.equal(f.refreshes, 1);
  assert.equal(f.page.data.familyList.length, 0);
  assert.equal(f.page.data.familyBusyId, 0);
  assert.equal(f.toasts.at(-1).title, '已通过，按期办理');
});

for (const [name, registrationTerm, expected] of [
  ['历史空期限', null, '12个月（允许生效日起算）'],
  ['一个月', { mode: 'months', months: 1 }, '1个月（允许生效日起算）'],
  ['其他月数', { mode: 'months', months: 6 }, '6个月（允许生效日起算）'],
  ['自定义未来日期', { mode: 'dates', startDate: '2099-01-01', endDate: '2099-01-31', reason: '合成验收：短期亲属探访' }, '2099-01-01 至 2099-01-31（自定义日期）'],
]) {
  test(`员工端实际卡片转换与经理确认展示申请期限：${name}`, async () => {
    const f = fixture();
    const row = f.toFamilyRow({ ...f.page.data.familyList[0], registrationTerm });
    assert.equal(row.termText, expected);
    f.page.data.familyList = [row];
    await f.page.onApproveFamily(tap);
    assert.ok(f.dialogs[0].content.includes(expected));
    assert.match(f.dialogs[0].content, /未来起始日需等待/);
    if (registrationTerm?.mode === 'dates') {
      assert.equal(row.termReason, registrationTerm.reason);
      assert.ok(f.dialogs[0].content.includes(`自定义原因：${registrationTerm.reason}`));
    } else assert.equal(row.termReason, '');
    assert.deepEqual(f.reviews, [[73, 'approve']]);
    assert.doesNotMatch(f.toasts.at(-1).title, /正在开通/);
  });
}

test('取消确认不审批、不刷新，释放按钮后可以再次打开', async () => {
  const f = fixture({ confirm: false });
  await f.page.onApproveFamily(tap);
  await f.page.onApproveFamily(tap);
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.refreshes, 0);
  assert.equal(f.page.data.familyList.length, 1);
  assert.equal(f.page.data.familyBusyId, 0);
});

test('原生确认弹窗失败有提示、无未捕获拒绝、不审批、不锁死', async () => {
  const f = fixture({ modalError: { errMsg: 'showModal:fail native unavailable' } });
  await assert.doesNotReject(() => f.page.onApproveFamily(tap));
  assert.equal(f.reviews.length, 0);
  assert.equal(f.toasts.length, 1);
  assert.equal(f.toasts[0].icon, 'none');
  assert.ok(f.toasts[0].title);
  assert.equal(f.page.data.familyList.length, 1);
  assert.equal(f.page.data.familyBusyId, 0);
});

test('审批接口失败展示服务端原因，保留待审批卡片并恢复按钮', async () => {
  const f = fixture({ reviewError: new Error('当前记录已被其他经理处理') });
  await f.page.onApproveFamily(tap);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.refreshes, 0);
  assert.equal(f.toasts.at(-1).title, '当前记录已被其他经理处理');
  assert.equal(f.page.data.familyList.length, 1);
  assert.equal(f.page.data.familyBusyId, 0);
});

test('确认弹窗等待与审批请求等待期间重复点击均不重复提交或退回', async () => {
  const modal = deferred(), review = deferred();
  const f = fixture({ modalWait: modal.promise, reviewWait: review.promise });
  const first = f.page.onApproveFamily(tap);
  assert.equal(f.page.data.familyBusyId, 73);
  await f.page.onApproveFamily(tap);
  await f.page.onReturnFamily(tap);
  assert.equal(f.dialogs.length, 1);
  modal.resolve();
  // The page and fixture promises cross VM realms; drain their microtasks.
  await new Promise(setImmediate);
  assert.equal(f.reviews.length, 1);
  await f.page.onApproveFamily(tap);
  assert.equal(f.reviews.length, 1);
  review.resolve();
  await first;
  assert.equal(f.refreshes, 1);
  assert.equal(f.page.data.familyBusyId, 0);
});

test('无效id和已有其他操作时不打开弹窗', async () => {
  const f = fixture();
  await f.page.onApproveFamily({ currentTarget: { dataset: {} } });
  f.page.data.familyBusyId = 99;
  await f.page.onApproveFamily(tap);
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.reviews.length, 0);
});

test('退回办公室仍要求原因，带原因时只提交return', async () => {
  const empty = fixture();
  await empty.page.onReturnFamily(tap);
  assert.equal(empty.reviews.length, 0);
  assert.equal(empty.toasts[0].title, '请填写退回原因');
  const f = fixture({ reason: '  资料不清晰  ' });
  await f.page.onReturnFamily(tap);
  assert.deepEqual(f.reviews, [[73, 'return', '资料不清晰']]);
  assert.equal(f.refreshes, 1);
});

test('正式WXML按钮仍绑定审批事件且保留无资料禁用，不绕过审核', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/approvals/approvals.wxml'), 'utf8');
  const button = wxml.match(/<button\b[^>]*bindtap="onApproveFamily"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button, /data-id="\{\{item.id\}\}"/);
  assert.match(button, /disabled="\{\{familyBusyId !== 0 \|\| !item.files.length\}\}"/);
  assert.match(wxml, /没有资料，不能通过/);
});

test('员工端所有原生弹窗确认/取消文字常量（含条件分支）符合四字符限制', () => {
  const violations = [];
  function checkText(node, file, property) {
    if (ts.isStringLiteralLike(node)) {
      if (Array.from(node.text).length > 4) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        violations.push(`${path.relative(root, file.fileName)}:${line} ${property}=${node.text}`);
      }
    } else if (ts.isConditionalExpression(node)) {
      checkText(node.whenTrue, file, property);
      checkText(node.whenFalse, file, property);
    }
  }
  for (const fileName of ts.sys.readDirectory(root, ['.ts'], ['**/miniprogram_npm/**'])) {
    const file = ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isPropertyAssignment(node) && ['confirmText', 'cancelText'].includes(node.name.getText(file))) {
        checkText(node.initializer, file, node.name.getText(file));
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  assert.deepEqual(violations, []);
});
