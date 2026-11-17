const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const app = path.resolve(__dirname, '..');
const evidence = path.resolve(app, '../../outputs/omission-release-20261117/integrations-browser');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withPage(run) {
  fs.mkdirSync(evidence, { recursive: true });
  const build = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'integrations-browser.tsx')], bundle: true, format: 'iife', jsx: 'automatic', write: false, outfile: path.join(evidence, 'fixture.js'), alias: { '@': path.join(app, 'src'), '@/lib/auth': path.join(__dirname, 'integrations-browser-auth.ts'), '@/lib/perm': path.join(__dirname, 'integrations-browser-auth.ts'), '@pms/api-client': path.join(__dirname, 'integrations-browser-api.ts') }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"' } });
  for (const file of build.outputFiles) fs.writeFileSync(file.path, file.contents);
  fs.writeFileSync(path.join(evidence, 'fixture.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  const server = http.createServer((req, res) => { const file = req.url.slice(1).split('?')[0]; if (!['fixture.html', 'fixture.js', 'fixture.css'].includes(file)) { res.writeHead(404); res.end(); return; } res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html;charset=utf-8'); res.end(fs.readFileSync(path.join(evidence, file))); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/fixture.html`;
  const profile = path.join(evidence, `chrome-${Date.now()}`);
  const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--disable-gpu', `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
  let socket;
  try {
    let port;
    for (let n = 0; n < 200; n++) { try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {} if (port) break; await pause(100); }
    assert.ok(port, 'Chrome debug port');
    let tab;
    for (let n = 0; n < 100; n++) { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url === url); if (tab) break; await pause(100); }
    assert.ok(tab, 'fixture tab'); socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    let id = 0; const pending = new Map();
    socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => reject(Error(method + ' timeout')), 15000); pending.set(key, m => { clearTimeout(timer); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); }); socket.send(JSON.stringify({ id: key, method, params })); });
    const js = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const wait = async expression => { for (let n = 0; n < 160; n++) { if (await js(expression)) return; await pause(80); } assert.fail('wait: ' + expression); };
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const textClick = text => js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
    const input = (selector, value) => js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const screen = async name => { const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(evidence, name), Buffer.from(r.data, 'base64')); };
    const viewport = width => call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
    await viewport(1280); await wait("!!document.querySelector('form input') && document.body.textContent.includes('现有工作站')");
    await run({ js, wait, click, textClick, input, screen, viewport });
  } finally { socket?.close(); child.kill(); await new Promise(resolve => server.close(resolve)); }
}
test('system devices: registration, failure/wait/success, secret lifecycle, scope and responsive UI', async () => {
  await withPage(async ({ js, wait, click, textClick, input, screen, viewport }) => {
    await screen('devices-desktop.png');
    await input('form input', '独立写卡电脑');
    await js("window.__mode = 'error'"); await click('form button[type=submit]');
    await wait("!!document.querySelector('[role=alert]')");
    assert.equal(await js("document.querySelector('form input').value"), '独立写卡电脑'); await screen('registration-error.png');
    await js("window.__mode = 'wait'"); await click('form button[type=submit]');
    await wait("document.querySelector('form button[type=submit]').disabled");
    assert.equal(await js("document.querySelector('form button[type=submit]').textContent"), '正在处理…'); await screen('registration-wait.png');
    await js("window.__mode = 'success'; window.__release()");
    await wait("!!document.querySelector('textarea')"); assert.equal(await js("document.querySelector('textarea').value"), 'SYNTHETIC-ISSUER-SECRET');
    await screen('registration-success.png');
    await js('window.__switchIdentity()'); await wait("!document.querySelector('textarea')");
    await js("(() => { const e=document.querySelector('select'); e.value='standard'; e.dispatchEvent(new Event('change', {bubbles:true})); })()");
    await wait("document.querySelectorAll('form input[type=text], form input:not([type])').length >= 2");
    assert.equal(await js("document.querySelectorAll('form input')[1].checkValidity()"), true, 'HTML v-pattern accepts dotted resource');
    await input('form input', '合成标准写卡工作站');
    await js("Array.from(document.querySelectorAll('form label')).find(l=>l.textContent.includes('读取实卡 UID')).querySelector('input').click()");
    const pairedBefore = await js("window.__calls.filter(c=>c.name==='enroll').length"); await click('form button[type=submit]');
    await wait("document.body.textContent.includes('必须同时支持')");
    assert.equal(await js("window.__calls.filter(c=>c.name==='enroll').length"), pairedBefore, 'incomplete physical capability pair cannot enroll');
    await js("Array.from(document.querySelectorAll('form label')).find(l=>l.textContent.includes('按已分配卡号写卡并回读')).querySelector('input').click()");
    await screen('standard-write-registration.png'); await click('form button[type=submit]');
    await wait("window.__calls.some(c=>c.name==='enroll')");
    const registered = await js("window.__calls.filter(c=>c.name==='enroll').at(-1).request");
    assert.equal(registered.kind,'workstation'); assert.ok(['card.inspect','card.write'].every(o=>registered.resources[0].capabilities.some(c=>c.operation===o && c.revision===1)));
    await wait("!!document.querySelector('textarea')"); await wait("Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('轮换密钥'))");
    await textClick('已保存，隐藏密钥'); await wait("!document.querySelector('textarea')");
    await js("window.confirm = () => false"); const before = await js('window.__calls.length'); await textClick('轮换密钥'); assert.equal(await js('window.__calls.length'), before, 'cancel must not rotate');
    await js("window.confirm = () => true"); await textClick('停用连接'); await wait("document.body.textContent.includes('已停用')");
    await viewport(390); await screen('devices-narrow.png'); assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'no horizontal overflow');
    await textClick('轮换密钥'); await wait("!!document.querySelector('textarea')");
    await js('window.__switchIdentity(false)'); await wait("!document.querySelector('textarea') && document.body.textContent.includes('全部小区数据范围')");
    assert.equal(await js("localStorage.length + sessionStorage.length"), 0, 'credentials never persisted');
    // An enrollment response from a former identity must never reveal a secret.
    await js('window.__switchIdentity(true)'); await wait("!document.querySelector('form button[type=submit]').disabled");
    await js("window.__mode = 'wait'"); await click('form button[type=submit]'); await wait("document.querySelector('form button[type=submit]').disabled");
    await js("const release = window.__release; window.__switchIdentity(); window.__mode = 'success'; release();");
    await pause(200); assert.equal(await js("!!document.querySelector('textarea')"), false, 'late enrollment secret suppressed');
  });
});
