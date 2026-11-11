const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const evidence = path.resolve(app, '../../outputs/statistics-width');

// Actual Shell, router, boundary, preferences, statistics page and production CSS.
// Only transport is synthetic; never connect to PMS/MIS or write business data.
const entry = `
import React, {lazy, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter, Routes, Route, useNavigate, useLocation} from 'react-router-dom';
import Shell from '@/components/Shell';
import Statistics from '@/pages/Statistics';
import UiPreferencesProvider from '@/components/UiPreferencesProvider';
import {auth} from '@/lib/auth';
import {IconSprite} from '@/components/Icon';
import {Toaster} from '@/components/ui';
import '@/styles/design.css';
import '@/styles/app.css';
import '@/styles/large.css';
import '@/styles/guards.css';
import '@/styles/calendar.css';
import '@/styles/erp-reference.css';
auth.setLogin({accessToken:'synthetic.'+btoa(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600}))+'.signature',user:{id:1,name:'合成验收',roleNames:['管理员']}});
auth.setAccess({isTenantAdmin:true,offices:[]},auth.captureIdentity());
const DeferredStatistics = lazy(()=>new Promise(resolve=>{
  window.__releaseStatistics=()=>resolve({default:Statistics});
  if(!location.search.includes('route-loading')) window.__releaseStatistics();
}));
function StatisticsRoute(){
  const loc=useLocation();
  if(loc.search.includes('route-crash')) throw Error('合成页面渲染错误');
  return <Suspense fallback={<div data-testid="route-loading">页面加载中…</div>}><DeferredStatistics/></Suspense>;
}
function Navigation(){window.__navigate=useNavigate();return null;}
createRoot(document.getElementById('root')).render(<BrowserRouter><UiPreferencesProvider><IconSprite/><Navigation/><Routes><Route element={<Shell/>}><Route path="/statistics" element={<StatisticsRoute/>}/><Route path="/today" element={<div data-testid="ordinary">普通业务页</div>}/></Route></Routes><Toaster/></UiPreferencesProvider></BrowserRouter>);
`;

async function fixture(run, query = '') {
  fs.mkdirSync(evidence, {recursive:true});
  const apiFile = path.join(__dirname, 'statistics-browser-api.ts').replaceAll('\\','/');
  const built = await esbuild.build({
    stdin:{contents:entry,loader:'tsx',resolveDir:app,sourcefile:'statistics-width-fixture.tsx'},
    bundle:true,write:false,format:'iife',jsx:'automatic',outfile:'fixture.js',
    alias:{'@':path.join(app,'src'),'@pms/shared-types':path.join(app,'../../packages/shared-types/src/index.ts')},
    plugins:[{name:'isolated-transport',setup(build){
      build.onResolve({filter:/^@pms\/api-client$/},()=>({path:'api',namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
        export * from '${apiFile}';
        import {request as statisticsRequest} from '${apiFile}';
        import {DEFAULT_PREFERENCES} from '@/lib/ui-preferences-core';
        export const repairs={badgeCounts:async()=>({dispatch:0,pool:0})};
        export async function request(options){
          if(options.url==='/auth/ui-preferences') return {...DEFAULT_PREFERENCES};
          return statisticsRequest(options);
        }
      `,loader:'ts',resolveDir:app}));
    }}],
    define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""','import.meta.env.VITE_API_BASE_URL':'"/api/v1"'},
  });
  const js = built.outputFiles.find(f=>f.path.endsWith('.js')).contents;
  const css = built.outputFiles.find(f=>f.path.endsWith('.css')).contents;
  const server = http.createServer((req,res)=>{
    const type = req.url === '/fixture.js' ? 'js' : req.url === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type',{'js':'text/javascript','css':'text/css','html':'text/html; charset=utf-8'}[type]);
    res.end(type==='js'?js:type==='css'?css:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const page = await browser.newPage({viewport:{width:2894,height:1448},acceptDownloads:false});
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Fail closed: this fixture must never call a real API or remote asset.
    await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    await page.goto(origin+'/statistics'+query);
    await run(page);
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
}

async function sizing(page) {
  return page.evaluate(()=>{
    const c=document.querySelector('.content'),w=c.querySelector('.wrap'),style=getComputedStyle(c);
    const available=c.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    const table=document.querySelector('.stats-annual-table'),scroll=document.querySelector('.stats-table-scroll');
    const office=table?.querySelector('thead .stats-office-col')?.getBoundingClientRect();
    const total=table?.querySelector('thead .stats-total-col')?.getBoundingClientRect();
    const years=table?[...table.querySelectorAll('thead .stats-year-col')]:[];
    return {viewport:innerWidth,available,wrap:w.getBoundingClientRect().width,maxWidth:getComputedStyle(w).maxWidth,
      outerOverflow:document.documentElement.scrollWidth>innerWidth+1||c.scrollWidth>c.clientWidth+1,
      visibleYears:table?.getClientRects().length?years.filter(cell=>{const r=cell.getBoundingClientRect();return r.left>=office.right-1&&r.right<=total.left+1;}).length:null,
      yearCount:years.length,tableOverflow:scroll?scroll.scrollWidth>scroll.clientWidth+1:false,
      fontSize:table?.querySelector('tbody .stats-year-col')?getComputedStyle(table.querySelector('tbody .stats-year-col')).fontSize:null};
  });
}
function assertFluid(m,label){
  assert.ok(Math.abs(m.wrap-m.available)<=1,label+' fills available content '+JSON.stringify(m));
  assert.equal(m.maxWidth,'none',label+' has no fixed maximum');
  assert.equal(m.outerOverflow,false,label+' contains overflow in the report');
}

async function generate(page){
  await page.locator('.stats-filter-entry').waitFor();
  if(await page.locator('.stats-filter-entry').getAttribute('aria-expanded')==='false') await page.locator('.stats-filter-entry').click();
  await page.locator('[data-testid=stats-submit]').click();
  await page.locator('.stats-annual-table').waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-testid=stats-generating]'));
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.stats-filter-float')).opacity==='0'&&!document.querySelector('.stats-filter-float').getAnimations().some(a=>a.playState==='running'));
}

test('统计路由：异步加载、结果及页面异常始终全宽，切换普通路由恢复限宽', {timeout:90000},async()=>{
  await fixture(async page=>{
    await page.locator('[data-testid=route-loading]').waitFor();
    assertFluid(await sizing(page),'route loading');
    await page.screenshot({path:path.join(evidence,'statistics-route-loading.png')});
    await page.evaluate(()=>window.__releaseStatistics());
    await generate(page);
    assertFluid(await sizing(page),'success');
    await page.evaluate(()=>window.__navigate('/statistics?route-crash'));
    await page.getByText('这个页面出错了',{exact:true}).waitFor();
    assertFluid(await sizing(page),'page boundary');
    await page.screenshot({path:path.join(evidence,'statistics-route-error.png')});
    await page.evaluate(()=>window.__navigate('/today'));
    await page.locator('[data-testid=ordinary]').waitFor();
    const ordinary=await sizing(page);
    assert.ok(Math.abs(ordinary.wrap-Math.min(1460,ordinary.available))<=1,'other routes keep the original cap');
    await page.evaluate(()=>window.__navigate('/statistics'));
    await page.locator('.stats').waitFor();
    assertFluid(await sizing(page),'return to statistics');
  },'?route-loading');
});

test('统计宽屏：1440/1920/2894/3840 展示更多年份，390/320 不产生页面横向滚动', {timeout:90000},async()=>{
  await fixture(async page=>{
    await generate(page);
    const measurements=[];
    for(const width of [1440,1920,2894,3840,390,320]){
      await page.setViewportSize({width,height:width>=2894?1448:1000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const m=await sizing(page); measurements.push(m); assertFluid(m,String(width));
      await page.screenshot({path:path.join(evidence,`statistics-${width}.png`)});
    }
    const desktop=measurements.filter(m=>m.viewport>=1440);
    for(let i=1;i<desktop.length;i++){
      assert.ok(desktop[i].visibleYears>=desktop[i-1].visibleYears,'wider screens show at least as many full columns');
      assert.equal(desktop[i].fontSize,desktop[0].fontSize,'do not shrink report typography');
    }
    assert.ok(desktop[2].visibleYears>desktop[0].visibleYears,'user-sized wide screen exposes more years');
    assert.equal(desktop[3].tableOverflow,false,'4K fits the fixture without unnecessary table scrolling');
    fs.writeFileSync(path.join(evidence,'measurements.json'),JSON.stringify(measurements,null,2));
  });
});
