const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
const deadline = Date.parse('2026-11-06T00:00:00+08:00');
const token = id => `e30.${Buffer.from(JSON.stringify({ sub: id, exp: deadline / 1000 })).toString('base64url')}.synthetic`;
const user = id => ({ id, tenantId: 3, name: `synthetic-${id}` });
function compile(file, require, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, require, ...extra }, { filename: file });
  return module.exports;
}
function load() {
  let now = deadline - 3600000;
  const storage = new Map();
  const store = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  const { auth, useSession } = compile('lib/auth.ts', name => {
    assert.equal(name, 'react');
    return { useSyncExternalStore: (_subscribe, read) => read() };
  }, {
    window: { sessionStorage: store, addEventListener() {} }, document: { addEventListener() {} },
    Date: class extends Date { static now() { return now; } }, queueMicrotask,
    atob: s => Buffer.from(s, 'base64').toString('binary'), setTimeout: () => 1, clearTimeout() {},
  });
  return { auth, useSession, login: id => auth.setLogin({ accessToken: token(id), user: user(id), tokenType: 'Bearer' }), expire: () => { now = deadline; } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function component(h, file, requests) {
  let previousDeps, cleanup;
  const callbacks = [], toasts = [], navigations = [];
  const react = {
    useState: initial => [initial, () => {}], useRef: initial => ({ current: initial }),
    useCallback: callback => { callbacks.push(callback); return callback; },
    useEffect: (effect, deps) => {
      if (!previousDeps || deps.some((value, i) => value !== previousDeps[i])) {
        cleanup?.(); previousDeps = deps; cleanup = effect();
      }
    }, lazy: () => () => null,
  };
  const exports = compile(file, name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'react-router-dom') return { useNavigate: () => (...args) => navigations.push(args), useLocation: () => ({ pathname: '/today' }) };
    if (name === '@pms/api-client') return { auth: { me: () => { const r = deferred(); requests.push(r); return r.promise; } } };
    if (name === '@/lib/auth') return h;
    if (name === '@/components/ui') return { toast: (...args) => toasts.push(args) };
    return { default: () => null };
  });
  return { render: exports.default, finish: (...args) => callbacks[0](...args), unmount: () => cleanup?.(), toasts, navigations };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const access = n => ({ communityIds: [n] });
const equalAccess = (auth, expected) => assert.equal(JSON.stringify(auth.getAccess()), JSON.stringify(expected));

test('real auth rejects late success/failure for A→B and identical-token A→B→A', () => {
  for (const aba of [false, true]) {
    const h = load(); h.login(1); const old = h.auth.captureIdentity();
    h.login(2); if (aba) h.login(1);
    const current = h.auth.captureIdentity();
    if (aba) assert.equal(old.token, current.token, 'same-second JWT must be identical');
    h.auth.setAccess(access(2), current);
    h.auth.setAccess(access(1), old); equalAccess(h.auth, access(2));
    h.auth.setAccess(null, old); equalAccess(h.auth, access(2));
    assert.equal(h.auth.isCurrent(old), false);
    assert.equal(h.auth.isCurrent(current), true, 'setAccess must not advance login generation');
    h.auth.setAccess(access(3), current); equalAccess(h.auth, access(3));
    h.auth.setAccess(access(99)); equalAccess(h.auth, access(3));
  }
});

test('real App effect captures identity, reruns for identical-token generation, and cleans up', async () => {
  const h = load(), requests = [], app = component(h, 'App.tsx', requests);
  h.login(1); app.render();
  h.login(2); h.login(1); app.render();
  assert.equal(requests.length, 2, 'identical-token login must rerun effect');
  requests[1].resolve({ access: access(2) }); await flush(); equalAccess(h.auth, access(2));
  requests[0].resolve({ access: access(1) }); await flush(); equalAccess(h.auth, access(2));
  h.login(2); app.render(); app.unmount();
  requests[2].resolve({ access: access(99) }); await flush(); equalAccess(h.auth, null);
});

test('real App completion cannot infer current identity after replacement, logout or expiry', async () => {
  for (const change of ['replace', 'aba', 'logout', 'expiry']) {
    for (const failure of [false, true]) {
      const h = load(), requests = [], app = component(h, 'App.tsx', requests);
      h.login(1); app.render();
      if (change === 'logout') h.auth.clear();
      else if (change === 'expiry') h.expire();
      else { h.login(2); if (change === 'aba') h.login(1); h.auth.setAccess(access(2), h.auth.captureIdentity()); }
      if (failure) requests[0].reject(Error('synthetic failure')); else requests[0].resolve({ access: access(1) });
      await flush(); equalAccess(h.auth, ['replace', 'aba'].includes(change) ? access(2) : null);
    }
  }
});

test('real Login finishLogin suppresses stale success/failure permission writes, toast and navigation', async () => {
  for (const change of ['replace', 'aba', 'logout', 'expiry']) {
    for (const failure of [false, true]) {
      const h = load(), requests = [], login = component(h, 'pages/Login.tsx', requests);
      login.render(); const pending = login.finish(token(1), user(1));
      if (change === 'logout') h.auth.clear();
      else if (change === 'expiry') h.expire();
      else { h.login(2); if (change === 'aba') h.login(1); h.auth.setAccess(access(2), h.auth.captureIdentity()); }
      if (failure) requests[0].reject(Error('synthetic failure')); else requests[0].resolve({ access: access(1) });
      await pending;
      equalAccess(h.auth, ['replace', 'aba'].includes(change) ? access(2) : null);
      assert.equal(login.toasts.length, 0, `${change}/${failure}: no stale success toast`);
      assert.equal(login.navigations.length, 0, `${change}/${failure}: no stale navigation`);
    }
  }
});

test('real Login current success and fallback failure complete normally', async () => {
  for (const failure of [false, true]) {
    const h = load(), requests = [], login = component(h, 'pages/Login.tsx', requests);
    login.render(); const pending = login.finish(token(1), user(1));
    if (failure) requests[0].reject(Error('synthetic failure')); else requests[0].resolve({ access: access(1) });
    await pending; equalAccess(h.auth, failure ? null : access(1));
    assert.equal(login.toasts.length, 1); assert.equal(login.navigations.length, 1);
    assert.equal(login.navigations[0][0], '/today');
  }
});

test('real auth rejects late success/failure after logout and expiry', () => {
  for (const end of ['clear', 'expire']) {
    const h = load(); h.login(1); const old = h.auth.captureIdentity();
    if (end === 'clear') h.auth.clear(); else h.expire();
    h.auth.setAccess(access(1), old); equalAccess(h.auth, null);
    h.auth.setAccess(null, old); equalAccess(h.auth, null);
    assert.equal(h.auth.isCurrent(old), false);
    assert.equal(h.auth.getToken(), undefined);
    h.auth.setAccess(access(2), h.auth.captureIdentity()); equalAccess(h.auth, null);
  }
});
