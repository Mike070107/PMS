const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');

test('公寓三个查询页携带分类，对账按日/方式/退费下钻并支持分页及失败重试', async () => {
  const built = await esbuild.build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/es/locale/zh_CN';
      import {BillsTab,ReportTab,ReconTab} from '@/legacy/pages/FeesPage';
      import '@/styles/design.css';import '@/styles/app.css';import '@/styles/guards.css';
      const mode=new URLSearchParams(location.search).get('mode');
      createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN}><App>{mode==='bills'?<BillsTab readOnly communityType="apartment" onOpenHouse={()=>{}}/>:mode==='reports'?<ReportTab communityType="apartment"/>:<ReconTab communityType="apartment"/>}</App></ConfigProvider>);`, loader: 'tsx', resolveDir: app },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js',
    alias: { '@': path.join(app, 'src'), '@legacy': path.join(app,'../admin-web/src'), '@pms/shared-types': path.join(app,'../../packages/shared-types/src/index.ts') },
    plugins: [{ name: 'isolated-adapters', setup(build) {
      build.onResolve({ filter: /^(@pms\/api-client|@\/lib\/auth)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        if (args.path.endsWith('/auth')) return { contents: `const session={user:{id:1},access:{isTenantAdmin:true}};export const useSession=()=>session;export const auth={getToken:()=>null};`, loader: 'js' };
        return { loader: 'js', contents: `
          window.__calls=[];window.__failDetail=false;
          export class ApiError extends Error {}
          const cell={amountCents:8000,chargedCents:10000,refundedCents:2000,count:2};
          const byMethod={wechat:{...cell,amountCents:10000,count:1},unknown:{...cell,amountCents:-2000,count:1}};
          export async function request({url,query={}}){
            window.__calls.push({url,query});
            if(url==='/communities')return [{id:1,name:'测试公寓',communityType:'apartment'},{id:2,name:'普通住宅',communityType:'community'}];
            if(url==='/fees/bills')return {rows:[],total:0};
            if(url==='/fees/bills/summary')return {billCount:0,dueCents:0,paidCents:0,unpaidCents:0,unpaidCount:0};
            if(url==='/fees/reports/summary')return {range:query,previousRange:query,totals:{netCents:8000,chargedCents:10000,refundedCents:2000,receiptCount:2,houseCount:1,itemCount:2},previous:{},trend:[],byMethod:[],byFee:[],byCommunity:[],byCashier:[]};
            if(url==='/fees/reports/reconciliation')return {range:query,methods:['wechat','unknown'],rows:[{day:'2026-11-11',...cell,byMethod}],totals:{...cell,byMethod}};
            if(url==='/fees/reports/detail'){
              if(window.__failDetail)throw Error('合成明细读取失败');
              return {rows:[{id:query.offset+1,source:'pms',occurredAt:'2026-11-11T10:00:00+08:00',communityName:'测试公寓',address:'A栋101',ownerName:'测试业主',feeName:'房租',amountCents:8000,method:'wechat',receiptNo:'SYN-1'}],count:51,totals:{amountCents:8000}};
            }
            return [];
          }
        ` };
      });
    } }], define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.VITE_API_BASE_URL': '"/api/v1"' },
  });
  const server = http.createServer((req, res) => {
    const file = req.url?.split('?')[0];
    const ext = file === '/fixture.js' ? 'js' : file === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8' }[ext]);
    res.end(ext === 'html' ? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root" style="padding:16px"></div><script src="/fixture.js"></script>' : built.outputFiles.find(f => f.path.endsWith('.' + ext)).contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
    for (const mode of ['bills','reports','recon']) {
      await page.goto(origin+'/?mode='+mode);
      const endpoint=mode==='bills'?'/fees/bills':mode==='reports'?'/fees/reports/summary':'/fees/reports/reconciliation';
      await page.waitForFunction(endpoint=>window.__calls.some(c=>c.url===endpoint),endpoint);
      assert.equal(await page.evaluate(endpoint=>window.__calls.find(c=>c.url===endpoint).query.communityType,endpoint),'apartment');
    }
    const lastDetail = () => page.evaluate(()=>window.__calls.filter(c=>c.url==='/fees/reports/detail').at(-1).query);
    await page.getByRole('button',{name:'2026-11-11',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByText('测试业主',{exact:true}).waitFor();
    assert.equal((await lastDetail()).key,'2026-11-11');
    assert.equal((await lastDetail()).communityType,'apartment');
    await dialog.locator('.ant-pagination-item-2').click();
    await page.waitForFunction(()=>window.__calls.some(c=>c.url==='/fees/reports/detail'&&c.query.offset===50));
    await dialog.locator('.ant-modal-footer button').click();
    await page.locator('tbody tr').filter({hasText:'2026-11-11'}).getByRole('button').nth(2).click();
    await dialog.getByText('测试业主',{exact:true}).waitFor();
    assert.equal((await lastDetail()).paymentMethod,'未记录');
    await dialog.locator('.ant-modal-footer button').click();
    await page.getByText('红冲及退费',{exact:true}).first().locator('..').getByRole('button').click();
    await dialog.getByText('测试业主',{exact:true}).waitFor();
    assert.equal((await lastDetail()).amountKind,'refunded');
    fs.mkdirSync(path.join(app,'../../outputs/apartment-reconciliation'),{recursive:true});
    for (const width of [390,320]) {
      await page.setViewportSize({width,height:844});
      // Resize can occur during AntD's zoom with a transform origin from the desktop click.
      // Measure the settled dialog, not the transient entrance transform.
      await page.waitForFunction(()=>{const el=document.querySelector('.ant-modal');return el&&el.getBoundingClientRect().width>0&&getComputedStyle(el).transform==='none'&&!/ant-zoom-(enter|leave)/.test(el.className);});
      const geometry=await dialog.evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,client:document.documentElement.clientWidth}));
      assert.ok(geometry.left>=0&&geometry.right<=geometry.client+1,JSON.stringify({width,...geometry}));
      const scroll=dialog.locator('.ant-table-content');
      assert.ok(await scroll.evaluate(el=>el.scrollWidth>el.clientWidth&&getComputedStyle(el).overflowX==='auto'));
      await page.screenshot({path:path.join(app,`../../outputs/apartment-reconciliation/mobile-${width}.png`),animations:'disabled'});
    }
    await dialog.locator('.ant-modal-footer button').click();
    await page.evaluate(()=>window.__failDetail=true);
    await page.getByRole('button',{name:'2026-11-11',exact:true}).click();
    await dialog.getByText('合成明细读取失败',{exact:true}).waitFor();
    await page.evaluate(()=>window.__failDetail=false);
    await dialog.locator('.ant-alert-action button').click();
    await dialog.getByText('测试业主',{exact:true}).waitFor();
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
