const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..');
const out = path.resolve(app, '../../outputs/image-preview-unification-20261117');

test('actual login QR panel previews without authentication and dismisses expired/cancelled images', { timeout: 60000 }, async () => {
  // Exercise the actual internal panel and launch helper; no real auth requests or tokens.
  const source = fs.readFileSync(path.join(app, 'src/pages/Login.tsx'), 'utf8');
  const panel = source.slice(source.indexOf('function QrPanel('));
  assert.ok(panel.startsWith('function QrPanel('));
  const entry = `import React,{useState,useEffect,useCallback,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import Icon,{IconSprite} from '@/components/Icon';
import ImagePreviewButton from '@/components/ImagePreviewButton';
import {wechatLaunchHref} from '@/lib/wechatLaunch';
import '@/styles/design.css';import '@/styles/app.css';
window.tickets=0;window.successes=0;window.nextStatus='pending';
window.failTicket=new URLSearchParams(location.search).has('error');
const authApi={qrLoginTicket:async()=>{window.tickets++;if(window.failTicket)throw Error('合成出码失败');if(new URLSearchParams(location.search).has('loading')&&window.tickets===1)await new Promise(resolve=>window.releaseTicket=resolve);return {ticket:'synthetic-only',qrImage:'/sample.png',expiresIn:120,launchScheme:'weixin://dl/business/?t=synthetic-only'};},qrLoginStatus:async()=>({status:window.nextStatus})};
${panel}
const onSuccess=async()=>{window.successes++;};
createRoot(document.getElementById('root')).render(<><IconSprite/><QrPanel onSuccess={onSuccess}/></>);`;
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
      const visit = query => page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
      const opener = page.getByRole('button', { name: '预览图片：微信扫码登录', exact: true });
      const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
      const open = async () => { await (width === 375 ? opener.tap() : opener.click()); await dialog.locator('img').evaluate(img => img.decode()); };
      await visit('loading');
      await page.getByText('生成中…', { exact: true }).waitFor();
      assert.equal(await opener.count(), 0);
      await page.evaluate(() => window.releaseTicket());
      await page.getByAltText('微信扫码登录', { exact: true }).waitFor();
      assert.equal(await opener.count(), 1, 'active login QR must offer shared preview');
      await open();
      await dialog.getByRole('button', { name: '放大', exact: true }).click();
      assert.equal(await dialog.getByLabel('缩放比例').textContent(), '120%');
      await page.screenshot({ path: path.join(out, `login-qr-${width}.png`) });
      if (width === 375) await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).tap();
      else await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.ok(await opener.evaluate(el => document.activeElement === el));
      assert.equal(await page.evaluate(() => window.tickets), 1);
      assert.equal(await page.getByRole('link', { name: '打开本机微信登录', exact: true }).getAttribute('href'), 'weixin://dl/business/?t=synthetic-only');
      for (const status of ['expired', 'cancelled']) {
        await open();
        await page.evaluate(status => { window.nextStatus = status; }, status);
        await dialog.waitFor({ state: 'hidden', timeout: 6000 });
        await page.getByRole('button', { name: '刷新二维码', exact: true }).waitFor();
        assert.equal(await opener.count(), 0, 'expired QR must not remain previewable');
        assert.equal(await page.evaluate(() => !!document.querySelector('[inert]')), false);
        assert.equal(await page.getByText('打开本机微信登录', { exact: true }).getAttribute('href'), null);
        const before = await page.evaluate(() => window.tickets);
        await page.evaluate(() => { window.nextStatus = 'pending'; });
        await page.getByRole('button', { name: '刷新二维码', exact: true }).click();
        await opener.waitFor();
        assert.equal(await page.evaluate(() => window.tickets), before + 1);
      }
      assert.equal(await page.evaluate(() => window.successes), 0);
      await visit('error');
      await page.getByText('合成出码失败', { exact: true }).waitFor();
      assert.equal(await opener.count(), 0);
      await page.evaluate(() => { window.failTicket = false; });
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await opener.waitFor();
      assert.equal(await page.evaluate(() => window.successes), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
