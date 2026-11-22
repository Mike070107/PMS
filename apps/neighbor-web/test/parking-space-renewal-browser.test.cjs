const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http'),fs=require('node:fs');
const {createRequire}=require('node:module');const {chromium}=require('playwright-core');
const app=path.resolve(__dirname,'..'),evidence=path.resolve(app,'../../outputs/parking-space-renewal-recovery');
const esbuild=createRequire(require.resolve('vite'))('esbuild');
// REAL ParkingSpaces -> Editor -> RenewSheet -> API adapter -> poll -> independent readback.
// This is browser fixture evidence, NOT live API/auth/SQL/device/payment acceptance.
test('两库正式车位入口：分类保存、授权和统一收银台入口', {timeout:180000},async()=>{
 fs.mkdirSync(evidence,{recursive:true});const apiFile=path.join(__dirname,'parking-space-renewal-browser-api.ts');
 const built=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import ParkingSpaces from '@/pages/ParkingSpaces';import '@/styles/design.css';import '@/styles/app.css';const garage=new URLSearchParams(location.search).get('garage')==='civil'?'civil':'main';createRoot(document.getElementById('root')).render(<ConfigProvider><App><ParkingSpaces garage={garage}/></App></ConfigProvider>);`,loader:'tsx',resolveDir:app},bundle:true,write:false,outfile:'entry.js',format:'iife',jsx:'automatic',alias:{'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""'},plugins:[{name:'safe-api-fixture',setup(b){b.onResolve({filter:/^@pms\/api-client$/},()=>({path:apiFile}));b.onResolve({filter:/^@\/lib\/(auth|perm)$/},a=>({path:a.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path.endsWith('/perm')?'export const can=()=>true;':`export const useSession=()=>({user:{id:1,name:'测试收费员'},access:{isTenantAdmin:true,scopeAll:true,communityIds:[2]}});`}));}}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.contents||'';
 const server=http.createServer((req,res)=>{if(req.url==='/entry.js'){res.setHeader('content-type','text/javascript');res.end(js);}else if(req.url==='/entry.css'){res.setHeader('content-type','text/css');res.end(css);}else{res.setHeader('content-type','text/html');res.end('<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;const errors=[],results=[];
 try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1050},timezoneId:'Asia/Shanghai'}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const origin=`http://127.0.0.1:${server.address().port}`;await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const calls=()=>page.evaluate(()=>window.__renewFixture.calls);
 const writes=async name=>(await calls()).filter(c=>c.name===name);
 async function open(garage='main',scenario='success',width=1440){await page.setViewportSize({width,height:1050});await page.goto(`${origin}/?garage=${garage}&scenario=${scenario}`);await page.evaluate(()=>localStorage.clear());await page.getByRole('button',{name:`编辑车位 ${garage==='main'?'A-021':'RF-021'}`,exact:true}).click();return page.getByRole('dialog');}
 async function renew(){
  await page.getByRole('button',{name:'查询现场并续期收费',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'续期收费 · 沪ATEST01'});
  const link=sheet.getByRole('link',{name:'去收银台续费'});
  assert.equal(await link.getAttribute('href'),'/cashier?renewPlate='+encodeURIComponent('沪ATEST01'));
  assert.equal((await writes('createParkingOperation')).length,0);
  assert.equal((await writes('renewDeliyunVehicle')).length,0);
  return sheet;
 }
 async function noOverflow(name){const sizes=await page.evaluate(()=>{const s=document.querySelector('.sheet');return{width:innerWidth,document:document.documentElement.scrollWidth,sheet:s.clientWidth,content:s.scrollWidth};});assert.ok(sizes.document<=sizes.width+1,JSON.stringify(sizes));assert.ok(sizes.content<=sizes.sheet+1,JSON.stringify(sizes));await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true,animations:'disabled'});return sizes;}
 for(const garage of ['main','civil']){
  await page.goto(`${origin}/?garage=${garage}`);
  const binding=page.locator('.sp-bound-vehicle').first();
  await binding.waitFor();
  assert.match(await binding.innerText(),/沪ATEST01.*228\/3\/501/s);
  assert.match(await binding.innerText(),/本车联系手机 13900001234/);
  assert.match(await binding.innerText(),/业主电话 13800000001/);
  await page.evaluate(()=>{
   window.__renewFixture.space.vehicleBindings['沪ATEST01'].endDate='2028-01-31';
   window.dispatchEvent(new Event('focus'));
  });
  await page.locator('.sp-bound-vehicle').filter({hasText:'2028-01-31'}).first().waitFor();
 }
 // 新规格：默认产权，可显式切租赁再恢复产权；保留备注/来源，不PATCH业务日期。
 for(const garage of ['main','civil']){
  let sheet=await open(garage);assert.equal((await writes('createParkingOperation')).length,0);assert.equal(await sheet.getByLabel('备注',{exact:true}).inputValue(),'原备注不能被类别覆盖');
  await sheet.getByLabel('车位类别',{exact:true}).selectOption('rental');await sheet.getByRole('button',{name:'保存档案',exact:true}).click();await page.getByRole('button',{name:`编辑车位 ${garage==='main'?'A-021':'RF-021'}`,exact:true}).click();sheet=page.getByRole('dialog');assert.equal(await sheet.getByLabel('车位类别',{exact:true}).inputValue(),'rental');
  await sheet.getByLabel('车位类别',{exact:true}).selectOption('property');await sheet.getByRole('button',{name:'保存档案',exact:true}).click();await page.getByRole('button',{name:`编辑车位 ${garage==='main'?'A-021':'RF-021'}`,exact:true}).click();
  const patches=(await writes('request')).filter(c=>c.data.method==='PATCH');assert.equal(patches.length,2);for(const p of patches){assert.equal('endDate'in p.data.data,false);assert.equal('source'in p.data.data,false);assert.equal(p.data.data.note,'原备注不能被类别覆盖');}assert.equal(patches[1].data.data.category,'property');
  await renew();
  await noOverflow(garage+'-cashier-entry');
  results.push({garage,cashierLink:true,directWrites:0});
 }
 await open('civil','success',390);await renew();results.push({mobile:await noOverflow('civil-390-cashier-entry')});
 // Exact authorization, not the mere existence of a queried record.
 for(const garage of ['main','civil']){await open(garage,'unauthorized');await page.getByRole('button',{name:'查询现场并续期收费'}).click();await page.getByRole('alert').filter({hasText:'未授权'}).waitFor();assert.equal((await writes('createParkingOperation')).length,0);results.push({garage,unauthorizedBlocked:true});}
 // Waiting lookup locks archive save and preserves draft.
 sheet=await open('main','lookupWait',390);await sheet.getByLabel('备注',{exact:true}).fill('等待时保留草稿');await sheet.getByRole('button',{name:'查询现场并续期收费'}).click();assert.equal(await sheet.getByRole('button',{name:'处理中…',exact:true}).isDisabled(),true);await page.evaluate(()=>window.__renewFixture.released=true);await page.getByRole('dialog',{name:'续期收费 · 沪ATEST01'}).waitFor();await page.getByRole('button',{name:/关闭/}).last().click();assert.equal(await page.getByLabel('备注',{exact:true}).inputValue(),'等待时保留草稿');results.push({lookupWaitingSaveLocked:true,draftRetained:true});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify({fixtureOnly:true,realComponents:['ParkingSpaces','ParkingSpaceEditor','RenewSheet','DateInput','OwnerBusinessContact'],liveApiAuthSqlDevicesPayments:false,results,errors},null,2));
 }catch(e){fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({message:e.message,stack:e.stack,errors,results},null,2));if(browser)for(const c of browser.contexts())for(const p of c.pages())await p.screenshot({path:path.join(evidence,'failure.png'),fullPage:true,animations:'disabled'}).catch(()=>{});throw e;}
 finally{await browser?.close();await new Promise(r=>server.close(r));}
});
