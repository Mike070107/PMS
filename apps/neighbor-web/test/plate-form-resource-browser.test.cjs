const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright-core');
const esbuild = require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app = path.resolve(__dirname, '..');
test('actual plate form limits blob allocation and releases removed/unmounted image and PDF resources', { timeout: 60000 }, async () => {
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{MemoryRouter}from'react-router-dom';import PlateForm from '@/pages/PlateForm';import{IconSprite}from '@/components/Icon';import '@/styles/design.css';import '@/styles/app.css';
window.liveUrls=new Set();window.createdUrls=[];const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=x=>{const u=create(x);window.liveUrls.add(u);window.createdUrls.push(u);return u;};URL.revokeObjectURL=u=>{window.liveUrls.delete(u);revoke(u);};const root=createRoot(document.getElementById('root'));window.unmountFixture=()=>root.unmount();root.render(<React.StrictMode><IconSprite/><MemoryRouter><PlateForm/></MemoryRouter></React.StrictMode>);`;
  const built = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: app }, bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js', alias: { '@': path.join(app, 'src') }, define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.VITE_API_BASE_URL': '""' }, plugins: [{ name: 'read-only-session', setup(b) {
    b.onResolve({ filter: /^@pms\/api-client$/ }, () => ({ path: 'session', namespace: 'synthetic' }));
    b.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: `export async function request(o){if(o.method&&o.method!=='GET')throw Error('No writes allowed');return {kind:'paid',status:'waiting',houseLabel:'合成测试住户',ownerName:'',expiresAt:'2030-01-01T12:00:00Z',relations:[],fileCount:0};}` }));
  } }] });
  const resources = new Map(built.outputFiles.map(f => ['/' + path.basename(f.path), f.contents]));
  resources.set('/', Buffer.from('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html');res.end(resources.get(req.url) || ''); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const png = fs.readFileSync(path.join(__dirname, 'fixtures/work-order-media/sample.png'));
    for (const width of [1440, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 812 } });const errors=[];page.on('pageerror', e => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.getByRole('heading', { name: '新车登记', exact: true }).waitFor();
      const files = Array.from({length: 11}, (_, i) => ({name:`image-${i}.png`,mimeType:'image/png',buffer:png}));
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', {name:'🖼 相册',exact:true}).click()]);
      await chooser.setFiles(files);
      await page.waitForFunction(() => document.querySelectorAll('.pf-thumb').length === 10);
      assert.equal(await page.evaluate(() => window.createdUrls.length), 10, 'do not allocate URLs for files beyond the ten-file limit');
      const first = await page.getByAltText('image-0.png',{exact:true}).getAttribute('src');
      await page.getByRole('button', {name:'预览图片：image-0.png',exact:true}).click();
      const dialog = page.getByRole('dialog',{name:'图片预览',exact:true});await dialog.locator('img').evaluate(img => img.decode());await page.keyboard.press('Escape');
      await page.locator('.pf-thumb').first().getByRole('button',{name:'删除',exact:true}).click();
      assert.equal(await page.evaluate(u => window.liveUrls.has(u),first),false);
      await page.locator('input[type=file][multiple]').setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\n%%EOF')});
      await page.getByText('sample.pdf',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:/^预览图片/}).count(),9,'PDF must not become an image trigger');
      assert.equal(await page.evaluate(() => window.liveUrls.size),10);
      const kept = await page.getByAltText('image-1.png',{exact:true}).getAttribute('src');
      await page.evaluate(() => window.unmountFixture());
      assert.equal(await page.evaluate(() => window.liveUrls.size),0,'unmount must release current image/PDF URLs, not the initial empty list');
      assert.equal(await page.evaluate(async u => {try{return (await fetch(u)).ok;}catch{return false;}},kept),false);
      assert.deepEqual(errors,[]);await page.close();
    }
  } finally {await browser?.close();server.closeAllConnections();await new Promise(r => server.close(r));}
});
