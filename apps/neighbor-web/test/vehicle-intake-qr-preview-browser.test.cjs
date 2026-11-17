const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..');
const out = path.resolve(app, '../../outputs/image-preview-unification-20261117');

test('actual issued vehicle intake sheet previews QR without navigation, revocation or parent close', { timeout: 60000 }, async () => {
  // Isolate the actual issued-intake Sheet JSX, not house picking or intake creation/API.
  const source = fs.readFileSync(path.join(app, 'src/pages/Vehicles.tsx'), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('      {newOpen ? (');
  const end = source.indexOf('\n\n    </>', start);
  assert.ok(start > 0 && end > start);
  const sheet = source.slice(start, end);
  const entry = `import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
import Icon,{IconSprite} from '@/components/Icon';import {Sheet,ErrorNote} from '@/components/ui';
import ImagePreviewButton from '@/components/ImagePreviewButton';
import '@/styles/design.css';import '@/styles/app.css';import '@/styles/erp-reference.css';
const params=new URLSearchParams(location.search);window.navigations=[];window.revocations=0;
function App(){
 const [newOpen,setNewOpen]=useState(true);const [newQr,setNewQr]=useState({id:7,kind:params.get('kind')||'paid',status:params.get('state')||'waiting',qr:params.has('missing')?null:{dataUrl:'/sample.png'}});
 const [newErr,setNewErr]=useState('');const [newHouse,setNewHouse]=useState(null);const [newKind,setNewKind]=useState('paid');const [voidReason,setVoidReason]=useState('');const [voidConfirm,setVoidConfirm]=useState(false);
 const creating=useRef(false);const newBusy=false;const communities=[];
 const nav=url=>window.navigations.push(url);const voidIntake=()=>{window.revocations++;};
 const createIntakeNow=()=>{throw Error('Creation is outside this issued-sheet fixture');};
 return <><IconSprite/>{!newOpen?<p>登记面板已关闭</p>:null}${sheet}</>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
  const built = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: app }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"test"' } });
  const resources = new Map(built.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
  resources.set('/', Buffer.from('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));
  resources.set('/sample.png', fs.readFileSync(path.join(__dirname, 'fixtures/work-order-media/sample.png')));
  const server = http.createServer((req, res) => { const url = req.url.split('?')[0];res.setHeader('Content-Type', url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : url.endsWith('.png') ? 'image/png' : 'text/html');res.end(resources.get(url) || ''); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    fs.mkdirSync(out, { recursive: true });
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 812 }, hasTouch: width === 375, isMobile: width === 375 });
      const errors = [];page.on('pageerror', e => errors.push(e.message));
      const visit = query => page.goto(`http://127.0.0.1:${server.address().port}/?${query}`);
      const opener = page.getByRole('button', { name: '预览图片：登记二维码', exact: true });
      const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
      for (const kind of ['paid', 'family']) {
        await visit(`kind=${kind}`);
        await page.getByAltText('登记二维码', { exact: true }).waitFor();
        assert.equal(await opener.count(), 1, 'issued intake QR must offer shared preview');
        const box = await opener.boundingBox();assert.ok(box.x >= 0 && box.x + box.width <= width);
        await page.getByLabel('撤销原因', { exact: true }).fill('合成保留输入');
        await (width === 375 ? opener.tap() : opener.click());
        await dialog.locator('img').evaluate(img => img.decode());
        await dialog.getByRole('button', { name: '放大', exact: true }).click();
        assert.equal(await dialog.getByLabel('缩放比例').textContent(), '120%');
        await page.screenshot({ path: path.join(out, `vehicle-intake-${kind}-${width}.png`) });
        if (width === 375) await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).tap();else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.ok(await opener.evaluate(el => document.activeElement === el));
        assert.equal(await page.getByLabel('撤销原因', { exact: true }).inputValue(), '合成保留输入');
        assert.ok(await page.getByRole('button', { name: '撤销本次登记', exact: true }).isDisabled());
        assert.equal(await page.getByRole('button', { name: '去收银台收费', exact: true }).count(), kind === 'paid' ? 1 : 0);
        assert.deepEqual(await page.evaluate(() => [window.navigations, window.revocations]), [[], 0]);
        assert.ok(await page.getByRole('button', { name: '查看/处理本次登记', exact: true }).isVisible());
        await page.keyboard.press('Escape');
        await page.getByText('登记面板已关闭', { exact: true }).waitFor();
      }
      await visit('state=void');
      await page.getByText(/已撤销，原二维码已失效/).waitFor();
      assert.equal(await opener.count(), 0);assert.equal(await page.getByRole('button', { name: '撤销本次登记', exact: true }).count(), 0);
      await visit('missing');
      await page.getByText('登记单已创建，但未获得二维码图片，请勿重复登记。', { exact: true }).waitFor();
      assert.equal(await opener.count(), 0);
      assert.deepEqual(errors, []);await page.close();
    }
  } finally { await browser?.close();server.closeAllConnections();await new Promise(r => server.close(r)); }
});
