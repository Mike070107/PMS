const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const evidence = path.resolve(app, '../../outputs/work-order-browser');

// 只替换 API/身份适配层；页面、详情抽屉、路由与样式使用实际生产源码。
// 合成数据独立静态服务，不请求 PMS/MIS，不执行任何真实业务写入。
const api = `
window.__calls = [];
const mode = new URLSearchParams(location.search).get('mode');
const content = '厨房水管漏水，检修接头和阀门，并记录维修结果。'.repeat(30);
const base = { communityId:1, requestId:1, summaryContent:content, summaryAddress:'合成小区20号楼101室', candidateIds:[], assigneeName:'测试维修工', createdAt:'2026-11-01T00:00Z', acceptedAt:null, completedAt:null, dispatchedAt:null, slaDueAt:null, photos:[], missingMaterials:[], photoCount:0 };
const orders = [
  {...base,id:1,orderNo:'SYN-1',status:'dispatched',urgent:true,dispatchedAt:'2026-11-10T00:00Z',createdAt:'2026-11-09T00:00Z'},
  {...base,id:2,orderNo:'SYN-2',status:'in_progress',acceptedAt:'2026-11-07T00:00Z'},
  {...base,id:3,orderNo:'SYN-3',status:'in_progress',acceptedAt:'2026-11-08T08:00+08:00',createdAt:'2026-11-02T00:00Z'},
  {...base,id:4,orderNo:'SYN-4',status:'in_progress',acceptedAt:'2026-11-08T00:00Z',createdAt:'2026-11-03T00:00Z'},
  {...base,id:5,orderNo:'SYN-5',status:'completed',completedAt:'2026-11-09T00:00Z'},
];
export const address = {tree:async()=>[]};
export const repairs = {
 list:async(q)=>{window.__calls.push(q); if(mode==='loading') return new Promise(()=>{}); if(mode==='error') throw Error('合成接口错误：请稍后重试'); return q.status ? [] : q.scope==='done' ? orders.filter(o=>o.status==='completed') : orders;},
 detail:async(id)=>{await new Promise(r=>setTimeout(r,500)); if(mode==='detail-error') throw Error('合成详情错误'); const workOrder=orders.find(o=>o.id===id); return {workOrder,request:{id:1,content,attachments:[]},materialUsages:[],logs:Array.from({length:40},(_,i)=>({id:i,action:'progress',createdAt:'2026-11-08T00:00Z',toStatus:'in_progress',note:'合成进度记录 '+i}))};},
 stockOptions:async()=>({warehouses:[],materials:[]}),
};
`;
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import WorkOrders from '@/pages/WorkOrders';
import {IconSprite} from '@/components/Icon';
import '@/styles/design.css';
import '@/styles/app.css';
import '@/styles/large.css';
import '@/styles/guards.css';
import '@/styles/calendar.css';
import '@/styles/erp-reference.css';
createRoot(document.getElementById('root')).render(<BrowserRouter><IconSprite/><div id="web"><aside className="side"><div className="brand">PMS · 合成验收</div></aside><section className="main"><header className="top"><div className="crumb">工单调度</div></header><div className="content"><div className="wrap"><WorkOrders/></div></div></section></div></BrowserRouter>);
`;

async function fixture(run) {
  fs.mkdirSync(evidence, {recursive:true});
  const built = await esbuild.build({
    stdin:{contents:entry,loader:'tsx',resolveDir:app,sourcefile:'work-orders-fixture.tsx'},
    bundle:true,write:false,format:'iife',jsx:'automatic',outfile:'fixture.js',
    alias:{'@':path.join(app,'src'),'@pms/shared-types':path.join(app,'../../packages/shared-types/src/index.ts')},
    plugins:[{name:'isolated-adapters',setup(build){
      build.onResolve({filter:/^@pms\/api-client$/},()=>({path:'api',namespace:'fixture'}));
      build.onResolve({filter:/^@\/lib\/auth$/},()=>({path:'auth',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='api'?api:'export const useSession=()=>({user:{id:1},access:{scopeAll:true}});',loader:'ts'}));
    }}],
    define:{'process.env.NODE_ENV':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""'},
  });
  const resources = new Map(built.outputFiles.map(f=>['/'+path.basename(f.path),f.contents]));
  resources.set('/',Buffer.from('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));
  const server = http.createServer((req,res)=>{
    const pathname = new URL(req.url,'http://localhost').pathname;
    res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html;charset=utf-8');
    res.end(resources.get(pathname)||'');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await run(page,`http://127.0.0.1:${server.address().port}`,errors);
    assert.deepEqual(errors,[], '真实组件不应抛出浏览器错误');
  } finally { await browser?.close(); await new Promise(r=>server.close(r)); }
}
const shot=(page,name)=>page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});
const ids=page=>page.locator('.wo-list-table tbody tr').evaluateAll(rows=>rows.map(r=>r.lastElementChild.textContent));

test('真实浏览器：桌面/窄屏省略号、整行开详情、下一步固定在四页签上方、更多可见', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  await page.goto(url+'/?view=list&filter=all');
  await page.locator('.wo-list-problem').first().waitFor();
  assert.deepEqual(await ids(page),['SYN-5','SYN-4','SYN-3','SYN-2','SYN-1']);
  assert.ok(await page.evaluate(()=>window.__calls.every(q=>q.sort==='repair_time_desc')));
  const clipping=await page.locator('.wo-list-problem').first().evaluate(el=>({width:el.clientWidth,full:el.scrollWidth,ellipsis:getComputedStyle(el).textOverflow}));
  assert.ok(clipping.full>clipping.width);assert.equal(clipping.ellipsis,'ellipsis');
  await shot(page,'desktop-list');
  // 点击问题单元格（不点专用按钮），路由应打开对应详情。
  await page.locator('.wo-list-table tbody tr').nth(1).locator('td').nth(1).click();
  await page.locator('.sheet').waitFor();
  await page.locator('.sh-b .empty').filter({hasText:'加载中'}).waitFor();
  await shot(page,'detail-loading');
  await page.locator('.sh-h .next').waitFor();
  for (const width of [1440,375]) {
   await page.setViewportSize({width,height:width===375?812:1000});
   for(const name of ['概况','处理进度','用料与收费','养护单']){
    await page.locator('.tabs button').getByText(name,{exact:true}).click();
    assert.equal(await page.locator('.next').count(),1);
    const before=await page.locator('.next').boundingBox();
    const tabs=await page.locator('.tabs').boundingBox();
    assert.ok(before.y+before.height<=tabs.y+1, `${width}/${name} 卡片应在页签上方`);
    await page.locator('.sh-b').evaluate(el=>el.scrollTop=el.scrollHeight);
    const after=await page.locator('.next').boundingBox();
    assert.ok(Math.abs(before.y-after.y)<1, `${width}/${name} 正文滚动不能带走卡片`);
    assert.ok(after.x>=0 && after.x+after.width<=width+1);
    if(name==='处理进度')assert.ok(await page.locator('.sh-b').evaluate(el=>el.scrollHeight>el.clientHeight));
   }
   await shot(page,width===375?'narrow-detail-fixed':'desktop-detail-fixed');
   await page.getByRole('button',{name:'更多 ▾'}).click();
   const last=page.locator('.menu button').last();
   assert.ok(await last.isVisible());
   const bounds=await last.boundingBox();
   assert.ok(bounds.y+bounds.height<=(width===375?812:1000),'更多菜单不应被屏幕或头部裁掉');
   await shot(page,width===375?'narrow-detail':'desktop-detail');
   await page.getByRole('button',{name:'更多 ▾'}).click();
  }
  await page.setViewportSize({width:812,height:375});
  assert.ok((await page.locator('.sh-h').boundingBox()).height<=375*0.7+1);
  assert.ok((await page.locator('.sh-b').boundingBox()).height>50, '横屏仍保留可滚动正文');
  await page.locator('.sh-h').evaluate(el=>el.scrollTop=el.scrollHeight);
  await shot(page,'landscape-detail');
  // 窄屏列表仅卡片内部横向滚动，不挤宽整个页面。
  await page.setViewportSize({width:375,height:812});
  await page.goto(url+'/?view=list&filter=all');
  await page.locator('.wo-list-problem').first().waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.ok(await page.locator('.wo-page-head h1').evaluate(el=>el.getBoundingClientRect().height<50), '窄屏标题不能被工具栏挤成竖排');
  assert.ok(await page.locator('.wo-list-table td:nth-child(3)').first().evaluate(el=>el.firstElementChild.getBoundingClientRect().right<=el.getBoundingClientRect().right-10), '状态标签应完整保留');
  await shot(page,'narrow-list');
 });
});

test('真实浏览器：等待、列表错误、详情错误与空结果都明确显示', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  await page.goto(url+'/?view=list&mode=loading');
  await page.getByText('加载中…',{exact:true}).waitFor(); await shot(page,'list-loading');
  await page.goto(url+'/?view=list&mode=error');
  await page.getByText('合成接口错误：请稍后重试',{exact:true}).waitFor();await shot(page,'list-error');
  await page.goto(url+'/?view=list&filter=all&mode=detail-error');
  await page.locator('.wo-list-problem').first().click();
  await page.getByText('合成详情错误',{exact:true}).waitFor();await shot(page,'detail-error');
  await page.goto(url+'/?view=list&filter=voided');
  await page.getByText('没有符合条件的工单',{exact:true}).waitFor();await shot(page,'list-empty');
 });
});
