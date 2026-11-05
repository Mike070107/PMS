const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const app = path.resolve(__dirname, '..');
const fromVite = createRequire(require.resolve('vite/package.json'));
const esbuild = fromVite('esbuild');
const pause = ms => new Promise(r => setTimeout(r, ms));

// Real Chromium + original AntD Cascader, isolated synthetic data, no API calls.
test('共享地址控件真实鼠标三级、跨期公区回填、收银回车DOM全选与续输', { timeout: 45000 }, async t => {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), 'AppData/Local/hermes/cache/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'pms-address-browser-'));
  const chrome = process.env.PMS_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  assert.ok(fs.existsSync(chrome), 'Set PMS_TEST_CHROME to a Chromium executable');
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'address-picker-browser.tsx')], bundle: true, format: 'iife', jsx: 'automatic', write: false,
    alias: { '@': path.join(app, 'src'), '@pms/shared-types': path.join(app, '../../packages/shared-types/src/index.ts') },
    outfile: path.join(dir, 'fixture.js'), define: { 'process.env.NODE_ENV': '"development"' },
  });
  for (const f of result.outputFiles) fs.writeFileSync(f.path, f.contents);
  fs.writeFileSync(path.join(dir, 'fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].slice(1);
    if (!['fixture.html', 'fixture.js', 'fixture.css'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(dir, name)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/fixture.html`;
  const profile = path.join(dir, 'chrome');
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore' });
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let n = 0; n < 100 && !fs.existsSync(portFile); n++) await pause(100);
    assert.ok(fs.existsSync(portFile), 'Chrome debugging port did not start');
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    let tabs;
    for (let n = 0; n < 50; n++) {
      tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (tabs.some(x => x.url === url)) break;
      await pause(100);
    }
    ws = new WebSocket(tabs.find(x => x.url === url).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', event => { const msg = JSON.parse(event.data); if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout: ' + method)); }, 8000);
      pending.set(n, msg => { clearTimeout(timer); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    const js = async expression => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    for (let n = 0; n < 100 && !await js("!!document.querySelector('#uni input')"); n++) await pause(100);
    const menu = '.ant-cascader-dropdown:not(.ant-select-dropdown-hidden) .ant-cascader-menu-item-content';
    const click = async (selector, text) => {
      const pos = await js(`(()=>{const e=${text === undefined ? `document.querySelector(${JSON.stringify(selector)})` : `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent===${JSON.stringify(text)})`};if(!e)throw Error('missing '+${JSON.stringify(text || selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pos });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pos });
      await pause(150);
    };
    const columns = () => js("document.querySelectorAll('.ant-cascader-dropdown:not(.ant-select-dropdown-hidden) .ant-cascader-menu').length");
    const enter = async () => { for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await pause(300); };
    const inputState = selector => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return {value:e.value,start:e.selectionStart,end:e.selectionEnd}})()`);
    for (const selector of ['#list input', '#uni input']) {
      await t.test(`${selector}: separate character events accumulate ABC`, async () => {
        await js(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
        for (const text of ['A', 'B', 'C']) { await call('Input.insertText', { text }); await pause(80); }
        assert.equal((await inputState(selector)).value, 'ABC');
      });
      await t.test(`${selector}: insertion at the middle preserves text and caret`, async () => {
        await js(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
        await call('Input.insertText', { text: 'AC' }); await pause(80);
        await js(`document.querySelector(${JSON.stringify(selector)}).setSelectionRange(1,1)`);
        await call('Input.insertText', { text: 'B' }); await pause(80);
        assert.deepEqual(await inputState(selector), { value: 'ABC', start: 2, end: 2 });
        await call('Input.insertText', { text: 'X' }); await pause(80);
        assert.deepEqual(await inputState(selector), { value: 'ABXC', start: 3, end: 3 });
        await click('#outside');
        await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        assert.deepEqual(await inputState(selector), { value: 'ABXC', start: 3, end: 3 });
        await js(`document.querySelector(${JSON.stringify(selector)}).setSelectionRange(2,2)`);
        await call('Input.insertText', { text: 'Y' }); await pause(80);
        assert.deepEqual(await inputState(selector), { value: 'ABYXC', start: 3, end: 3 });
      });
      await js(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
      for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await pause(100); await click('#outside');
    }
    await click('#list .ant-select-selector'); await click(menu, '测试二期（228弄）');
    assert.ok(await columns() >= 2); await click(menu, '6号楼'); assert.equal(await columns(), 3);
    await click(menu, '502 · 乙'); assert.equal(await js("document.querySelector('#list output').textContent"), '228/6/502');
    await click('#house .ant-select-selector'); await click(menu, '测试一期（198弄）'); await click(menu, '2号楼'); await click(menu, '201 · 甲');
    await click('#house .ant-select-selector'); await click(menu, '测试二期（228弄）'); assert.ok(await columns() >= 2, 'parent onIncomplete reset must retain partial navigation');
    await click(menu, '6号楼'); await click(menu, '本楼栋公共区域');
    const publicText = await js("document.querySelector('#house').innerText");
    assert.match(publicText, /228弄6号\/公共区域/); assert.ok(!publicText.includes('201'));
    await click('#uni .ant-select-selector'); await click(menu, '测试一期（198弄）'); assert.ok(await columns() >= 2);
    await click(menu, '2号楼'); assert.equal(await columns(), 3); await click(menu, '201 · 甲');
    await pause(200); assert.equal(await js('window.picked.hit.id'), 111);
    await js("document.querySelector('#uni input').focus();document.querySelector('#uni input').select()");
    await call('Input.insertText', { text: '228/6/502' }); await enter();
    const state = await js("(()=>{const e=document.querySelector('#uni input');return {value:e.value,start:e.selectionStart,end:e.selectionEnd}})()");
    assert.equal(state.value, '测试二期 / 228弄6号楼 / 502室'); assert.equal(state.start, 0); assert.equal(state.end, state.value.length);
    await click('#outside'); await js("document.querySelector('#uni input').focus()");
    assert.deepEqual(await inputState('#uni input'), { value: state.value, start: 0, end: state.value.length });
    await call('Input.insertText', { text: '198/2/201' }); assert.equal(await js("document.querySelector('#uni input').value"), '198/2/201');
    await enter(); assert.equal(await js('window.picked.hit.id'), 111);
    assert.ok((await js('window.terms')).every(term => !term.includes('测试')), 'display text must never become an API query');
    // Arbitrary list text survives blur/close and still reaches the 400ms callback.
    await js("document.querySelector('#list input').focus();document.querySelector('#list input').select()");
    await call('Input.insertText', { text: '维修单ABC' }); await click('#outside'); await pause(450);
    assert.equal(await js("document.querySelector('#list output').textContent"), '维修单ABC');
    t.diagnostic('real mouse columns, full→other phase→public, UniSearch columns, Enter DOM selection/replacement, arbitrary text blur: passed');
  } finally {
    ws?.close();
    if (child.pid) process.platform === 'win32' ? spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill();
    await new Promise(resolve => server.close(resolve));
    // Keep bundled fixture under the Hermes scratch directory for failure evidence.
  }
});
