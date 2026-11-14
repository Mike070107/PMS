const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core'),esbuild=require('esbuild');
const {listenBrowserLocal}=require('./local-browser-server.cjs');
const app=path.resolve(__dirname,'..'),out=path.resolve(app,'../../outputs/beijing-display-20261114');
test('真实今日页：UTC与+08同刻在四种设备时区都显示北京时间，纯收款日期保留', {timeout:60000},async()=>{
 const built=await esbuild.build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import Today from '@/pages/Today';import{IconSprite}from'@/components/Icon';import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';createRoot(document.getElementById('root')).render(<BrowserRouter><IconSprite/><main style={{padding:20}}><Today/></main></BrowserRouter>);`,resolveDir:app,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',outfile:'fixture.js',alias:{'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"'},plugins:[{name:'isolated-today',setup(b){
 b.onResolve({filter:/^(@pms\/api-client|@\/lib\/auth)$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path.endsWith('/auth')?`const access={scopeAll:true,isTenantAdmin:true,pages:{}};const session={generation:1,user:{id:1,name:'合成测试'},actingTenant:{id:1},access};export const useSession=()=>session;export const auth={getAccess:()=>access,getToken:()=>null};`:`
 export const repairs={list:async()=>[]};window.__calls=[];export async function request(o){window.__calls.push(o);if(o.method&&o.method!=='GET')throw Error('Forbidden write');
 if(o.url==='/business/transaction-ledger')return {rows:[],summary:{paidCents:0,refundedCents:0,paidCount:0,byService:[]}};
 if(o.url==='/fees/mis/today')return {paidCents:200,paidCount:2,paidHouses:2,refundedCents:0,byFee:[{feeCode:'property',name:'物业费',amountCents:200,count:2,houseCount:2}]};
 if(o.url==='/fees/mis/recent-payments')return {rows:['2026-11-14T06:58:00Z','2026-11-14T14:58:00+08:00'].map((recordedAt,i)=>({paidAt:'2026-11-14',address:'合成'+(i+1)+'号',ownerName:'测试',amountCents:100,billCount:1,recordedAt})),total:2,houseCount:2};
 throw Error('Unexpected API '+o.url);}` }));
 }}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.contents||'';
 const server=http.createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');res.end(js)}else if(req.url==='/fixture.css'){res.setHeader('content-type','text/css');res.end(css)}else{res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>')}});
 await listenBrowserLocal(server);const origin=`http://127.0.0.1:${server.address().port}`;let browser;const records=[];fs.mkdirSync(out,{recursive:true});
 try{browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const zone of ['UTC','America/Los_Angeles','Asia/Tokyo','Asia/Shanghai']){
  const context=await browser.newContext({timezoneId:zone,serviceWorkers:'block'}),errors=[];
  context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));await context.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  const page=await context.newPage();await page.goto(origin);await page.locator('.today-recent-time small').first().waitFor();
  assert.deepEqual(await page.locator('.today-recent-time small').allTextContents(),['更新 14:58','更新 14:58']);
  assert.deepEqual(await page.locator('.today-recent-time b').allTextContents(),['11-14','11-14']);
  assert.match(await page.locator('.today-recent-time small').first().getAttribute('title'),/北京时间.*非实际收款/);
  for(const width of [1440,390]){await page.setViewportSize({width,height:950});await page.screenshot({path:path.join(out,zone.replaceAll('/','-')+'-'+width+'.png'),fullPage:true});}
  const calls=await page.evaluate(()=>window.__calls);assert.equal(calls.filter(o=>o.method&&o.method!=='GET').length,0);assert.deepEqual(errors,[]);records.push({zone,clocks:await page.locator('.today-recent-time small').allTextContents(),errors,writeRequests:0});await context.close();
 }
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({fixtureOnly:true,realTodayAndCss:true,productionAuthOrPayments:false,records},null,2));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
