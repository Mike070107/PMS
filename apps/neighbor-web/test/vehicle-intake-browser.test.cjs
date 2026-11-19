const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const pause = ms => new Promise(r => setTimeout(r, ms));

test('real vehicle/cashier entries: opening is read-only, lock/reuse, explicit another, timeout/reload; desktop/mobile', { timeout: 90000 }, async () => {
  const app = path.resolve(__dirname, '..');
  const dir = path.resolve(app, '../../outputs/vehicle-registration-20261118/browser');
  fs.mkdirSync(dir, { recursive: true });
  const build = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'vehicle-intake-browser.tsx')], bundle: true, format: 'iife', jsx: 'automatic', write: false,
    outfile: path.join(dir, 'fixture.js'), alias: { '@': path.join(app, 'src'), '@pms/api-client': path.join(__dirname, 'vehicle-intake-browser-api.ts'), '@/lib/perm': path.join(__dirname, 'parking-browser-permission.ts') },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_LEGACY_BASE': '""', 'import.meta.env.VITE_API_BASE_URL': '"/api/v1"' } });
  for (const f of build.outputFiles) fs.writeFileSync(f.path, f.contents);
  fs.writeFileSync(path.join(dir, 'fixture.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].slice(1);
    if (!['fixture.html', 'fixture.js', 'fixture.css'].includes(name)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', name.endsWith('js') ? 'text/javascript' : name.endsWith('css') ? 'text/css' : 'text/html;charset=utf-8');
    res.end(fs.readFileSync(path.join(dir, name)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/fixture.html`;
  const profile = fs.mkdtempSync(path.join(dir, 'chrome-'));
  const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', url], { stdio: 'ignore' });
  let ws, js, call;
  const errors = [];
  try {
    let port = 0;
    for (let i = 0; i < 100; i++) {
      try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (Number.isInteger(port) && port > 0 && port <= 65535) break; }
      catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
      await pause(100);
    }
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'owned Chrome did not publish a ready DevTools endpoint');
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.url === url); if (!tab) await pause(100); }
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let next = 0; const pending = new Map();
    call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 10000);
      pending.set(id, m => { clearTimeout(timer); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
      if (m.method === 'Page.javascriptDialogOpening') void call('Page.handleJavaScriptDialog', { accept: true });
    });
    js = async expression => { const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const until = async expression => { for (let i = 0; i < 60; i++) { if (await js(expression)) return; await pause(100); } throw Error('UI condition timed out: ' + expression + '; exceptions: ' + JSON.stringify(errors)); };
    const count = () => js("JSON.parse(localStorage.getItem('synthetic-intakes')||'[]').length");
    const posts = () => js("window.__intakeCalls.filter(o=>o.url==='/vehicle-intakes'&&o.method==='POST').length");
    const click = async (selector, text) => {
      const p = await js(`(()=>{const e=${text ? `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)})` : `document.querySelector(${JSON.stringify(selector)})`};if(!e)throw Error('Missing control: '+${JSON.stringify(text || selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p });
      await pause(80);
    };
    const shot = async name => { const result = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(result.data, 'base64')); };
    await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await call('Page.reload');
    await until("document.querySelector('.newplate-bar button')&&!document.querySelector('.newplate-bar button').disabled");
    await click('.newplate-bar button', '新办车牌（付费）');
    assert.equal(await posts(), 0); assert.equal(await count(), 0);
    await shot('mobile-open-readonly');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }); await pause(80);
    assert.equal(await js("!!document.querySelector('.sheet')"), false);
    await click('.newplate-bar button', '亲情车（免费）');
    assert.equal(await posts(), 0);
    await click('.sheet button', '工作人员直接登记');
    assert.equal(await js("[...document.querySelectorAll('.sheet button')].filter(b=>b.textContent.includes('读取原登记')).every(b=>b.disabled)"), true);
    // A synchronous double dispatch before React's paint must not add another request.
    await js("document.querySelector('.sheet .btn.p')?.click()");
    await shot('mobile-waiting');
    await until("!document.querySelector('.sheet')&&document.querySelectorAll('.np-card').length===1");
    assert.equal(await posts(), 1); assert.equal(await count(), 1);
    await until("!!document.querySelector('.registration-workspace .registration-plate input')");
    assert.equal(await js("getComputedStyle(document.querySelector('.registration-house')).backgroundColor"), await js("(()=>{const p=document.createElement('span');p.style.background='var(--acc)';document.body.append(p);const c=getComputedStyle(p).backgroundColor;p.remove();return c})()"));
    await shot('cashier-registration-theme-390');
    await click('.intake-registration-heading button', '改由住户扫码');
    await click('.newplate-bar button', '亲情车（免费）'); await click('.sheet button', '生成/继续登记二维码');
    await until("!document.querySelector('.sheet')");
    assert.equal(await count(), 1); assert.equal(await js("document.querySelectorAll('.np-card').length"), 1);
    await click('.newplate-bar button', '亲情车（免费）'); await click('.sheet button', '再登记一辆（另建办理单）');
    await until("!document.querySelector('.sheet')&&document.querySelectorAll('.np-card').length===2");
    assert.equal(await count(), 2);
    await click('.newplate-bar button', '新办车牌（付费）'); await js('window.__failNext=true'); await click('.sheet button', '生成/继续登记二维码');
    await until("document.querySelector('.sheet [role=alert]')?.textContent.includes('合成超时')");
    const originalKey = await js("window.__intakeCalls.filter(o=>o.url==='/vehicle-intakes'&&o.method==='POST').at(-1).data.operationKey");
    assert.equal(await count(), 3); await shot('mobile-timeout-keeps-operation');
    await call('Page.reload'); await pause(400);
    await until("document.querySelector('.newplate-bar button')&&!document.querySelector('.newplate-bar button').disabled");
    await click('.newplate-bar button', '新办车牌（付费）'); await click('.sheet button', '生成/继续登记二维码');
    await until("!document.querySelector('.sheet')");
    assert.equal(await js("window.__intakeCalls.filter(o=>o.url==='/vehicle-intakes'&&o.method==='POST').at(-1).data.operationKey"), originalKey);
    assert.equal(await count(), 3);
    await shot('mobile-success-reused');
    // 办公室代填：真实组件 + 合成 multipart 接口；失败保留输入，确认后版本绑定
    const setInput = async (selector, value) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('.np-card .registration-options summary', '办公室资料确认与申请期限');
    await click('.np-card .np-office-head button');
    await setInput('.np-card .np-office input[aria-label="办公室代填车牌"]', '豫GQ3N07');
    await setInput('.np-card .np-office input[aria-label="办公室代填手机"]', '13900000000');
    await js('window.__failOffice=true');
    await click('.np-office button', '保存草稿');
    await until("document.querySelector('.np-office [role=alert]')?.textContent.includes('合成保存失败')");
    assert.equal(await js("document.querySelector('.np-office input[aria-label=\"办公室代填车牌\"]').value"), '豫GQ3N07', 'failed save retains office input');
    await shot('office-save-error-keeps-input');
    await js("(()=>{const input=document.querySelector('.np-office input[type=file]');const dt=new DataTransfer();dt.items.add(new File([new Uint8Array([0xff,0xd8,0xff,0xe0])],'office-xsz.jpg',{type:'image/jpeg'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await pause(120);
    assert.ok(await js("document.querySelectorAll('.np-office .np-office-file').length>=1"), 'picked file is listed before upload');
    await click('.np-office button', '确认并提交审核');
    await until("document.querySelector('.np-office')?.textContent.includes('已确认并提交办公室审核')");
    const officeRow = await js("JSON.parse(localStorage.getItem('synthetic-intakes')||'[]').find(r=>r.plate==='豫GQ3N07')");
    assert.equal(officeRow.status, 'submitted');
    assert.equal(officeRow.inputSource, 'office');
    assert.equal(officeRow.officeConfirmedVersion, officeRow.dataVersion);
    assert.ok(await js("document.querySelector('.np-office-head').textContent.includes('办公室已确认当前版本')"));
    await shot('mobile-office-confirmed');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); await pause(200);
    const officeGeometry = await js("(()=>{const c=document.querySelector('.np-office').getBoundingClientRect();return{left:c.left,right:c.right,viewport:innerWidth,body:document.documentElement.scrollWidth}})()");
    assert.ok(officeGeometry.left >= -1 && officeGeometry.right <= 1441 && officeGeometry.body <= 1441, JSON.stringify(officeGeometry));
    await shot('desktop-office-confirmed');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await pause(150);
    await click('#vehicles'); await click('.act button', '新车登记');
    const before = await posts(); assert.equal(await count(), 3);
    await click('.sheet .house-address-picker input'); await call('Input.insertText', { text: '228/3/502' }); await pause(400);
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    await until("[...document.querySelectorAll('.sheet button')].some(b=>b.textContent.includes('工作人员直接登记')&&!b.disabled)");
    assert.equal(await posts(), before, 'address/type selection is still read-only');
    await click('.sheet button', '工作人员直接登记'); await until("!!document.querySelector('.sheet [aria-label^=本次登记]')");
    assert.equal(await count(), 3);
    const geometry = [];
    for (const width of [390, 1440]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }); await pause(150);
      const g = await js("(()=>{const r=document.querySelector('.sheet').getBoundingClientRect();return{viewport:innerWidth,left:r.left,right:r.right,body:document.documentElement.scrollWidth}})()");
      geometry.push({ width, ...g }); assert.ok(g.left >= -1 && g.right <= width + 1 && g.body <= width + 1, JSON.stringify(g));
      await shot('vehicle-success-' + width);
    }
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await until("!document.querySelector('.sheet')");
    await click('#family');
    await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='办理详情')");
    await click('button', '办理详情'); await until("document.body.textContent.includes('申请期限：')");
    assert.ok(await js("document.body.textContent.includes('12个月（允许生效日起算）')"));
    await click('button', '修改申请期限');
    const setControl = async (selector, value) => {
      await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await pause(80);
    };
    await click('fieldset button', '6 个月');
    assert.equal(await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='办公室审核通过').disabled"), true, 'unsaved term cannot be silently approved');
    await js('window.__failFamily=true'); await click('button', '保存期限'); await shot('family-term-waiting');
    await until("document.body.textContent.includes('合成保存失败')");
    assert.equal(await js("document.querySelector('fieldset input[aria-label=自定义续期月数]').value"), '6', 'failed save retains office input');
    await shot('family-term-error-keeps-input');
    const patches = () => js("window.__intakeCalls.filter(o=>o.url==='/family-cars/901'&&o.method==='PATCH').length");
    const beforePatches = await patches();
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='保存期限');b.click();b.click();})()");
    await until("!document.querySelector('fieldset')"); assert.equal(await patches(), beforePatches + 1, 'synchronous save guard');
    await click('button', '办理详情'); await until("document.body.textContent.includes('6个月（允许生效日起算）')");
    await click('button', '修改申请期限'); await click('fieldset button', '自定日期');
    await setControl('fieldset input[type=date]', '2099-01-01');
    // Date fields live in separate labels: explicitly address the second date input.
    await js("(()=>{const e=document.querySelectorAll('fieldset input[type=date]')[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2099-01-31');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await setControl('fieldset textarea', '合成验收：自定义未来日期，等待起始日');
    const termGeometry = [];
    for (const width of [390, 1440]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 }); await pause(150);
      const body = await js('document.documentElement.scrollWidth'); assert.ok(body <= width + 1, `term form overflow: ${body}/${width}`);
      for (const end of [false, true]) {
        await js(`(()=>{const t=document.querySelector('[data-testid=family-cars-table]').closest('.t-scroll');t.scrollLeft=${end ? 't.scrollWidth' : '0'};})()`); await pause(80);
        const fields = await js("(()=>{const c=document.querySelector('[data-testid=family-cars-table]').closest('.t-scroll').getBoundingClientRect();return [...document.querySelectorAll('fieldset input,fieldset select,fieldset textarea')].map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,min:c.left,max:Math.min(innerWidth,c.right)}})})()");
        assert.ok(fields.every(r=>r.left>=r.min-1&&r.right<=r.max+1), `clipped term controls at ${width}/${end}: ${JSON.stringify(fields)}`);
        termGeometry.push({ width, scrolledToEnd: end, fields });
      }
      await shot('family-term-editor-' + width);
    }
    await click('button', '保存期限'); await until("!document.querySelector('fieldset')");
    await click('button', '办理详情'); await until("document.body.textContent.includes('2099-01-01 至 2099-01-31')");
    await click('button', '办公室审核通过'); await until("!document.body.textContent.includes('申请期限：')");
    await click('button', '办理详情'); await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='经理审核通过（按申请期限）')");
    assert.equal(await js("[...document.querySelectorAll('button')].some(b=>b.textContent==='修改申请期限')"), false, 'manager stage term is read-only');
    assert.ok(await js("document.body.textContent.includes('2099-01-01 至 2099-01-31')&&document.body.textContent.includes('合成验收：自定义未来日期')"));
    await shot('family-term-manager-readonly');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify({ syntheticOnly: true, drafts: await count(), geometry, termGeometry, errors }, null, 2));
    console.log('Browser evidence:', dir);
  } catch (error) {
    if (call) { try { const shot = await call('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'failure.png'), Buffer.from(shot.data, 'base64')); } catch {} }
    if (js) { try { fs.writeFileSync(path.join(dir, 'failure.txt'), await js('document.body.innerText')); } catch {} }
    throw error;
  } finally { ws?.close(); child.kill(); server.close(); }
});
