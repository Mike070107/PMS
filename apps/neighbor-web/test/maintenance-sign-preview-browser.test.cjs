const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..');
const out = path.resolve(app, '../../outputs/image-preview-unification-20261117');

test('actual maintenance phone-sign panel previews QR/signature without closing or retrying parent', { timeout: 60000 }, async () => {
  // Isolate the actual internal panel, not the editor's save/poll/print flow.
  const source = fs.readFileSync(path.join(app, 'src/components/maint/MaintEditor.tsx'), 'utf8');
  const panel = source.slice(source.indexOf('function PhoneSignPanel('));
  assert.ok(panel.startsWith('function PhoneSignPanel('));
  const labels = source.match(/^const SIGN_SLOT_LABELS.*$/m)[0];
  const entry = `import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {IconSprite} from '@/components/Icon';
import {Btn,Loading,toast} from '@/components/ui';
import ImagePreviewButton from '@/components/ImagePreviewButton';
import '@/styles/design.css';import '@/styles/app.css';import '@/styles/erp-reference.css';
${labels}\n${panel}
const status=new URLSearchParams(location.search).get('state')||'waiting';
function App(){const[closed,setClosed]=useState(false);const[retries,setRetries]=useState(0);return <><IconSprite/><output id="retries">{retries}</output>{closed?<p>父窗口已关闭</p>:<PhoneSignPanel state={{slot:'owner',status,qrDataUrl:'/sample.png',signUrl:'/sample.png',linkUrl:'https://example.invalid/synthetic-sign',expiresAt:Date.now()+60000,error:'合成错误'}} onRetry={()=>setRetries(n=>n+1)} onClose={()=>setClosed(true)}/>}</>;}
createRoot(document.getElementById('root')).render(<App/>);`;
  const built = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: app }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"test"' } });
  const resources = new Map(built.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
  resources.set('/', Buffer.from('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));
  resources.set('/sample.png', fs.readFileSync(path.join(__dirname, 'fixtures/work-order-media/sample.png')));
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    res.setHeader('Content-Type', url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : url.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(resources.get(url) || '');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    fs.mkdirSync(out, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } }); });
      const visit = state => page.goto(`http://127.0.0.1:${server.address().port}/?state=${state}`);
      for (const state of ['waiting', 'opened', 'signed']) {
        await visit(state);
        await page.locator('.cmdk .box').waitFor();
        const name = state === 'signed' ? '预览图片：签名' : '预览图片：签名二维码';
        const opener = page.getByRole('button', { name, exact: true });
        assert.equal(await opener.count(), 1, `${state} image must offer shared preview`);
        await (width === 375 ? opener.tap() : opener.click());
        const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
        await dialog.locator('img').evaluate(img => img.decode());
        const zoom = dialog.getByRole('button', { name: '放大', exact: true });
        await (width === 375 ? zoom.tap() : zoom.click());
        assert.equal(await dialog.getByLabel('缩放比例').textContent(), '120%');
        await page.screenshot({ path: path.join(out, `maint-${state}-${width}.png`) });
        if (width === 375) await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).tap();
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.ok(await opener.evaluate(el => document.activeElement === el));
        assert.equal(await page.locator('#retries').textContent(), '0');
        assert.equal(await page.getByText('父窗口已关闭', { exact: true }).count(), 0);
        if (state !== 'signed') {
          await page.getByRole('button', { name: '复制签字链接', exact: true }).click();
          assert.equal(await page.evaluate(() => window.copied), 'https://example.invalid/synthetic-sign');
          assert.equal(await page.getByAltText('签名二维码', { exact: true }).getAttribute('src'), '/sample.png');
        }
        await page.getByRole('button', { name: state === 'signed' ? '重新签一次' : '换一张二维码', exact: true }).click();
        assert.equal(await page.locator('#retries').textContent(), '1');
        await page.getByRole('button', { name: state === 'signed' ? '完成' : '关闭', exact: true }).click();
        assert.ok(await page.getByText('父窗口已关闭', { exact: true }).isVisible());
      }
      for (const state of ['loading', 'error', 'expired']) {
        await visit(state);
        await page.locator('.cmdk .box').waitFor();
        assert.equal(await page.getByRole('button', { name: /^预览图片/ }).count(), 0);
        if (state === 'loading') assert.ok(await page.getByRole('button', { name: '换一张二维码', exact: true }).isDisabled());
        if (state === 'error') assert.ok(await page.getByText('合成错误', { exact: true }).isVisible());
        if (state === 'expired') assert.ok(await page.getByText('二维码已过期', { exact: true }).isVisible());
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
