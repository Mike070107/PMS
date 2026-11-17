const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),http=require('node:http');
const {createRequire}=require('node:module'),{chromium}=require('playwright-core');
const app=path.resolve(__dirname,'..'),evidence=path.resolve(app,'../../outputs/omission-release-20261117/logs-feedback-browser');
const esbuild=createRequire(require.resolve('vite'))('esbuild');
async function fixture(){
 const built=await esbuild.build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import Logs from '@/pages/Logs';import{IconSprite}from'@/components/Icon';import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';import '@/styles/erp-reference.css';createRoot(document.getElementById('root')).render(<main style={{padding:16}}><IconSprite/><Logs/></main>);`,loader:'tsx',resolveDir:app},bundle:true,write:false,format:'iife',jsx:'automatic',outfile:'fixture.js',alias:{'@':path.join(app,'src')},define:{'import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""','import.meta.env.VITE_API_BASE_URL':'"/api/v1"'},plugins:[{name:'isolated-transport',setup(b){b.onResolve({filter:/^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path.endsWith('/auth')?'export const useSession=()=>({user:{id:1,tenantId:1}});':a.path.endsWith('/perm')?'export const can=()=>true;':`export async function request(o){window.__calls??=[];window.__calls.push(o);if(o.method&&o.method!=='GET')throw Error('No business writes in fixture');if(o.url==='/feedback'){if(location.search.includes('error'))throw Error('fixture offline');if(location.search.includes('waiting'))await new Promise(()=>{});return {list:location.search.includes('empty')?[]:[{id:1,kind:'suggestion',userName:'合成反馈人',content:'合成反馈：请查看施工照片',createdAt:'2026-11-16T07:33:00Z',status:'pending',attachments:[{url:'/api/v1/upload/file?key=uploads/front.jpg',name:'file'},{url:'/api/v1/upload/file?key=uploads/back.webp',name:'背面照片',mime:'image/webp'},{url:'/unknown-file',name:'有类型无扩展名',mime:'image/png'},{url:'/name-only',name:'附件照片.JPEG'},{url:'/broken.png',name:'损坏图片.png',mime:'image/png'},{url:'/document.pdf',name:'说明.pdf',mime:'application/pdf'},{url:'/clip.mp4',name:'视频.mp4',mime:'video/mp4'}],imageUrls:['/legacy.png']}],total:1};}if(o.url.endsWith('/logs'))return{list:[],total:0,page:1,pageSize:30};throw Error('unused overview');}` }));}}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.contents;
 const server=http.createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(js);}if(req.url==='/fixture.css'){res.setHeader('Content-Type','text/css');return res.end(css);}if(req.url.startsWith('/api/v1/upload/file')||req.url==='/unknown-file'||req.url==='/name-only'||req.url==='/legacy.png'){res.setHeader('Content-Type','image/svg+xml');return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#e8edf3"/><rect x="80" y="80" width="1440" height="840" rx="30" fill="#31558a"/><text x="160" y="520" font-size="100" fill="white">SYNTHETIC PHOTO</text></svg>`);}if(req.url==='/broken.png'){res.statusCode=404;return res.end();}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return{url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>server.close(r))};
}
async function openFeedback(page,url){await page.goto(url);await page.getByRole('tab',{name:'用户反馈',exact:true}).click();}
test('日志完整内容：图片缩略图、滚轮缩放、左键拖动、外部关闭及键盘/错误兼容',async()=>{
 const f=await fixture(),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{fs.mkdirSync(evidence,{recursive:true});for(const width of [1440,375]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await openFeedback(page,f.url);await page.locator('.fb-summary').click();const details=page.locator('.fb-detail-files');
  assert.equal(await details.locator('button.fb-thumb').count(),6,'图片扩展名、query key、MIME及旧imageUrls均渲染缩略图入口，损坏图片保留错误占位');
  await details.locator('.fb-thumb-error').waitFor();
  assert.equal(await details.locator('a[download]').count(),8,'图片和非图片附件均保留下载');
  assert.equal(await details.locator('button').filter({hasText:'说明.pdf'}).count(),0,'PDF不进入图片预览');
  await details.getByRole('button',{name:'预览附件：file',exact:true}).click();const dialog=page.getByRole('dialog',{name:'反馈附件预览',exact:true});await dialog.waitFor();
  const zoom=dialog.locator('.np-preview-zoom'),before=await zoom.boundingBox();
  await dialog.locator('header').hover();await page.mouse.wheel(0,-100);await page.waitForFunction(()=>document.querySelector('.np-preview-footer output')?.textContent==='120%');
  assert.ok((await zoom.boundingBox()).width>before.width*1.19,'弹窗内滚轮实际放大图片');
  const stage=await dialog.locator('.np-preview-stage').boundingBox(),x=stage.x+stage.width/2,y=stage.y+stage.height/2,scaled=await zoom.boundingBox();
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+45,y+35,{steps:5});await page.mouse.up();
  const panned=await zoom.boundingBox();assert.ok(panned.x-scaled.x>=44&&panned.y-scaled.y>=34,'左键拖动改变图片位置');
  await dialog.locator('.np-preview-stage').hover();await page.mouse.wheel(0,100);await page.waitForFunction(()=>document.querySelector('.np-preview-footer output')?.textContent==='100%');
  await page.keyboard.press('0');assert.ok(Math.abs((await zoom.boundingBox()).x-before.x)<1,'复位清除偏移');
  await dialog.locator('header b').click();assert.equal(await dialog.count(),1,'弹窗内点击不关闭');
  await page.keyboard.press('ArrowRight');await page.getByRole('dialog').getByText('背面照片',{exact:true}).waitFor();
  await page.screenshot({path:path.join(evidence,`preview-${width}.png`)});
  await page.mouse.click(2,2);await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.body.style.overflow),'','关闭恢复页面滚动');
  await details.getByRole('button',{name:'预览附件：损坏图片.png',exact:true}).click();await page.getByRole('alert').filter({hasText:'图片加载失败'}).waitFor();
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await details.getByRole('button',{name:'预览附件：file',exact:true}).click();assert.equal(await page.getByLabel('缩放比例').textContent(),'100%','重新打开清除缩放');
  await page.getByRole('button',{name:'关闭图片预览'}).click();await dialog.waitFor({state:'detached'});
  assert.ok((await details.boundingBox()).width <= width-64,'窄屏附件在视口宽度内换行');
  await page.screenshot({path:path.join(evidence,`thumbnails-${width}.png`),fullPage:true});
  assert.ok((await page.evaluate(()=>window.__calls)).every(o=>!o.method||o.method==='GET'),'无反馈状态写入');assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();await f.close();}
});
test('日志反馈等待、接口错误与空结果仍可辨认',async()=>{const f=await fixture(),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{for(const [state,text]of[['waiting','加载'],['error','用户反馈接口未就绪'],['empty','暂无用户反馈']]){const p=await browser.newPage();await openFeedback(p,f.url+'?'+state);await p.getByText(text,{exact:false}).first().waitFor();assert.equal(await p.getByRole('dialog').count(),0);await p.close();}}finally{await browser.close();await f.close();}});
