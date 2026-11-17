const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..');
const out = path.resolve(app, '../../outputs/image-preview-unification-20261117');

test('actual feedback attachments survive pick/paste/drop/remove and failed submission, with isolated preview', { timeout: 60000 }, async () => {
  const entry = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import FeedbackDialog from '@/components/FeedbackDialog';import {IconSprite} from '@/components/Icon';
import '@/styles/design.css';import '@/styles/app.css';import '@/styles/erp-reference.css';
window.uploads=[];window.submissions=[];
function App(){const[open,setOpen]=useState(true);return <><IconSprite/>{open?<FeedbackDialog open onClose={()=>setOpen(false)}/>:<p>反馈面板已关闭</p>}</>;}
createRoot(document.getElementById('root')).render(<App/>);`;
  const built = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: app }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'synthetic-feedback-only', setup(build) {
    build.onResolve({ filter: /^(@pms\/api-client|@\/lib\/upload)$/ }, args => ({ path: args.path, namespace: 'synthetic' }));
    build.onLoad({ filter: /.*/, namespace: 'synthetic' }, args => ({ contents: args.path.includes('api-client') ? `export async function request(options){if(options.method!=='POST'||options.url!=='/feedback')throw Error('Unexpected API');window.submissions.push(options.data);if(window.acceptSubmission)return {id:'synthetic-only'};throw Error('合成提交失败，内容保留');}` : `export async function uploadImage(file){window.uploads.push(file.name);if(window.holdUploads)await new Promise(resolve=>window.releaseUpload=()=>{window.holdUploads=false;resolve();});if(window.failOnceName===file.name){window.failOnceName=null;throw Error('合成第二张上传失败');}return '/synthetic/'+encodeURIComponent(file.name);}` }));
  } }] });
  const resources = new Map(built.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
  resources.set('/', Buffer.from('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));
  const sample = fs.readFileSync(path.join(__dirname, 'fixtures/work-order-media/sample.png'));
  const server = http.createServer((req, res) => { const url = req.url.split('?')[0];res.setHeader('Content-Type', url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : 'text/html');res.end(resources.get(url) || ''); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    fs.mkdirSync(out, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375 });
      const errors = [];page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.getByRole('textbox', { name: '反馈内容' }).fill('合成测试，失败后保留此内容');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '添加附件', exact: true }).click()]);
      await chooser.setFiles({ name: 'picked.png', mimeType: 'image/png', buffer: sample });
      await page.getByAltText('picked.png', { exact: true }).waitFor();
      const firstUrl = await page.getByAltText('picked.png', { exact: true }).getAttribute('src');
      const alive = url => page.evaluate(async u => { try { return (await fetch(u)).ok; } catch { return false; } }, url);
      const addVia = async (type, name, expectAdded = true) => {
        await page.locator('.fb-composer').evaluate((el, { type, name, base64 }) => {
          const data = new DataTransfer();data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type: 'image/png' }));
          el.dispatchEvent(type === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
        }, { type, name, base64: sample.toString('base64') });
        if (expectAdded) await page.getByAltText(name, { exact: true }).waitFor();
      };
      await addVia('paste', 'pasted.png');
      assert.ok(await alive(firstUrl), 'adding another attachment must not revoke the first image URL');
      await addVia('drop', 'dropped.png');
      assert.equal(await page.locator('.fb-att').count(), 3);
      assert.ok(await alive(firstUrl));
      const removedUrl = await page.getByAltText('pasted.png', { exact: true }).getAttribute('src');
      await page.getByRole('button', { name: '移除附件 pasted.png', exact: true }).click();
      assert.equal(await page.locator('.fb-att').count(), 2);
      assert.equal(await alive(removedUrl), false, 'removed image URL must be released');
      assert.ok(await alive(firstUrl), 'removing one image must preserve others');
      const trigger = page.getByRole('button', { name: 'picked.png', exact: true });
      await (width === 375 ? trigger.tap() : trigger.click());
      const dialog = page.getByRole('dialog', { name: '反馈图片预览', exact: true });
      await dialog.locator('img').evaluate(img => img.decode());
      await dialog.getByRole('button', { name: '放大', exact: true }).click();
      assert.equal(await dialog.getByLabel('缩放比例').textContent(), '120%');
      await page.screenshot({ path: path.join(out, `feedback-preview-${width}.png`) });
      if (width === 375) await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).tap();else await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.ok(await trigger.evaluate(el => document.activeElement === el));
      assert.deepEqual(await page.evaluate(() => [window.uploads, window.submissions]), [[], []]);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '合成提交失败，内容保留' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '反馈内容' }).inputValue(), '合成测试，失败后保留此内容');
      assert.equal(await page.locator('.fb-att').count(), 2);assert.ok(await alive(firstUrl), 'failed submission must retain usable previews');
      await trigger.click();await dialog.locator('img').evaluate(img => img.decode());await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => window.submissions.length === 2);
      assert.deepEqual(await page.evaluate(() => window.uploads), ['picked.png', 'dropped.png'], 'retry should reuse completed synthetic uploads');
      await page.keyboard.press('Escape');await page.getByText('反馈面板已关闭', { exact: true }).waitFor();
      assert.equal(await alive(firstUrl), false, 'unmount must release retained image URLs');
      // Hold the first upload; fail the second once. No real network or storage writes.
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.getByRole('textbox', { name: '反馈内容' }).fill('部分失败后保留');
      await page.locator('input[type=file]').setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: sample }, { name: 'second.png', mimeType: 'image/png', buffer: sample }]);
      await page.getByAltText('first.png', { exact: true }).waitFor();
      const retainedUrl = await page.getByAltText('first.png', { exact: true }).getAttribute('src');
      await page.evaluate(() => { window.holdUploads = true;window.failOnceName = 'second.png'; });
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.waitForFunction(() => typeof window.releaseUpload === 'function');
      await addVia('paste', 'busy-paste.png', false);await addVia('drop', 'busy-drop.png', false);
      assert.equal(await page.locator('.fb-att').count(), 2, 'in-flight uploads must reject attachment additions consistently with disabled picker');
      await page.evaluate(() => window.releaseUpload());
      await page.getByRole('alert').filter({ hasText: '合成第二张上传失败' }).waitFor();
      assert.ok(await alive(retainedUrl));
      assert.deepEqual(await page.evaluate(() => window.submissions), []);
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '合成提交失败，内容保留' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.uploads), ['first.png', 'second.png', 'second.png'], 'retry must not reupload the first completed attachment');
      assert.equal(await page.getByRole('textbox', { name: '反馈内容' }).inputValue(), '部分失败后保留');
      assert.equal(await page.locator('.fb-att').count(), 2);assert.ok(await alive(retainedUrl));
      assert.deepEqual(await page.evaluate(() => window.submissions[0].attachments.map(a => a.name)), ['first.png', 'second.png']);
      await page.evaluate(() => { window.acceptSubmission = true; });
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('反馈面板已关闭', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.uploads), ['first.png', 'second.png', 'second.png']);
      assert.equal(await alive(retainedUrl), false, 'successful synthetic submission must close and release previews');
      assert.deepEqual(errors, []);await page.close();
    }
  } finally { await browser?.close();server.closeAllConnections();await new Promise(r => server.close(r)); }
});
