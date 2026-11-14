const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),http=require('node:http');
const {createRequire}=require('node:module'),{chromium}=require('playwright-core');
const app=path.resolve(__dirname,'..'),api=path.resolve(app,'../api'),apiRequire=createRequire(path.join(api,'package.json'));
apiRequire('ts-node').register({project:path.join(api,'tsconfig.json'),transpileOnly:true});
apiRequire('reflect-metadata');
const {PGlite}=apiRequire('@electric-sql/pglite'),{DataSource}=apiRequire('typeorm');
const {BusinessTransaction}=apiRequire('./src/entities/business-transaction.entity.ts');
const {BusinessLedgerService}=apiRequire('./src/modules/business/business-ledger.service.ts');
const esbuild=createRequire(require.resolve('vite'))('esbuild');
const evidence=path.resolve(app,'../../outputs/records-operation-details-20261115');
// Real Records React -> loopback adapter -> real ledger service + PostgreSQL-compatible PGlite SQL.
// Authentication is a fixed scoped fixture; NO production DB, payment, assistant or device access.
test('办理记录中文系统操作：真实React与ledger SQL，桌面/窄屏、部分结果、人工、日期差异、等待/失败/恢复',{timeout:120000},async()=>{
 fs.mkdirSync(evidence,{recursive:true});const db=new PGlite();await db.waitReady;
 await db.exec(`CREATE TABLE communities(id int,tenant_id int,name text);CREATE TABLE buildings(id int,tenant_id int,lane text,building_no text,community_id int,road_name text);CREATE TABLE houses(id int,tenant_id int,building_id int,room_no text,shop_name text);CREATE TABLE users(id int,tenant_id int,name text);CREATE TABLE business_transactions(id bigint PRIMARY KEY,txn_no text,tenant_id int,community_id int,house_id int,created_by int,service_type text,status text,amount_cents int,payment_method text,external_sync_status text,created_at timestamptz,snapshot jsonb,quantity int,start_date date,end_date date);
 INSERT INTO communities VALUES(10,1,'隔离合成小区');INSERT INTO buildings VALUES(1,1,'','1');INSERT INTO houses VALUES(1,1,1,'101');INSERT INTO users VALUES(7,1,'合成收款人');`);
 const snapshots=[
  {vehicle:{plateNo:'沪TEST01'},parking:{systems:[{kind:'local',database:'parking1',sourceRecordId:'5273',label:'一期地面车库',previousEndDate:'2026-06-30'},{kind:'local',database:'parking2',sourceRecordId:'5274',label:'二期地面车库',previousEndDate:'2026-07-31'}],target:'local:phase1_parking',vehicleClass:'亲情车'},rule:{name:'亲情车'},estimate:{startDate:'2026-11-15',endDate:'2027-10-31'},execution:{steps:[{key:'local:parking2:5274',label:'二期地面车库',kind:'local',status:'waiting',operationId:72,note:'现场助手处理中'},{key:'local:parking1:5273',label:'一期地面车库',kind:'local',status:'done',operationId:71,note:'到期日已是本次目标'}]}},
  {vehicle:{plateNo:'沪TEST02'},parking:{systems:[{kind:'local',database:'parking1',sourceRecordId:'5275',label:'一期地面车库',previousEndDate:'2026-06-30'}]},execution:{manualDone:{at:'2026-11-15T00:00:00Z',by:7,note:'物业人工核查登记'}}},
  {vehicle:{plateNo:'沪TEST03'},parking:{newVehicle:true,target:'local:phase1_parking',systems:[{kind:'local',database:'parking2',sourceRecordId:'10',label:'二期地面车库'},{kind:'local',database:'parking2',sourceRecordId:'11',label:'二期大车库'}]},execution:{steps:[{key:'registration:parking2',label:'二期停车资料',kind:'local',status:'dry_run',note:'仅演练，不写入'},{key:'registration:check',label:'一期二期车牌查重',kind:'local',status:'waiting',note:'尚未新增'},{key:'registration:parking1',label:'一期地面车库',kind:'local',status:'failed',operationId:73,note:'设备确认缺失'}],finishedAt:'2026-11-15T00:10:00Z',lastError:'设备确认缺失'}},
 ];
 for(let i=0;i<snapshots.length;i++)await db.query(`INSERT INTO business_transactions VALUES($1,$2,1,10,1,7,'parking_monthly','paid',0,'alipay',$3,'2026-11-15T00:15:00+08',$4,11,'2026-11-15','2027-10-30')`,[301+i,'SYNTHETIC-'+i,['queued','synced','failed'][i],JSON.stringify(snapshots[i])]);
 const ds=new DataSource({type:'postgres',entities:[BusinessTransaction]});await ds.buildMetadatas();const real=ds.getRepository(BusinessTransaction);
 const wrap=qb=>{const clone=qb.clone.bind(qb);qb.clone=()=>wrap(clone());qb.getRawMany=async()=>{const[sql,params]=qb.getQueryAndParameters();return(await db.query(sql,params)).rows};qb.getRawOne=async()=>(await qb.getRawMany())[0];return qb};
 const repo={manager:{connection:{query:async(sql,params)=>(await db.query(sql,params)).rows}},createQueryBuilder:alias=>wrap(real.createQueryBuilder(alias))};
 const service=new BusinessLedgerService(repo),calls=[],errors=[];let fail=false,release;
 const held=new Promise(r=>release=r);let hold=true;
 const built=await esbuild.build({stdin:{resolveDir:app,loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import Records from '@/pages/Records';
 import '@/styles/app.css';import '@/styles/design.css';import '@/styles/guards.css';
 createRoot(document.getElementById('root')).render(<MemoryRouter><main style={{padding:16,maxWidth:1200,margin:'auto'}}><p>隔离合成数据 · 不收费、不下发设备</p><Records/></main></MemoryRouter>);`},bundle:true,write:false,outfile:'entry.js',format:'iife',jsx:'automatic',alias:{'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'scoped-ledger-fixture',setup(b){
  b.onResolve({filter:/^@pms\/api-client$/},()=>({path:'api',namespace:'fixture'}));
  b.onResolve({filter:/^@\/lib\/auth$/},()=>({path:'session',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='session'?`const session={generation:1,user:{id:7},actingTenant:{id:1},access:{scopeAll:false,communityIds:[10]}};export const useSession=()=>session;`:`export async function request(o){const q=new URLSearchParams();for(const [k,v]of Object.entries(o.query||{}))if(v!==undefined)q.set(k,String(v));const r=await fetch('/fixture'+o.url+'?'+q);const v=await r.json();if(!r.ok)throw Error(v.error);return v;}`}));
 }}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.contents||'';
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/fixture/')){
   calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams)});res.setHeader('content-type','application/json');
   try{assert.equal(req.method,'GET');assert.equal(url.pathname,'/fixture/business/transaction-ledger','禁止写接口');if(hold)await held;if(fail)throw Error('synthetic read failure');const q=Object.fromEntries(url.searchParams);q.page=Number(q.page||1);q.pageSize=Number(q.pageSize||20);return res.end(JSON.stringify(await service.list(q,{id:7,tenantId:1},{scopeAll:false,communityIds:[10]})));}catch(e){res.statusCode=400;return res.end(JSON.stringify({error:e.message}));}
  }
  if(url.pathname==='/entry.js'){res.setHeader('content-type','text/javascript');return res.end(js);}
  if(url.pathname==='/entry.css'){res.setHeader('content-type','text/css');return res.end(css);}
  res.setHeader('content-type','text/html;charset=utf-8');res.end('<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const width of [1440,390]){
   const page=await browser.newPage({viewport:{width,height:1100},timezoneId:'America/New_York'});page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/same key|unique.*key/i.test(m.text()))errors.push(m.text());});
   await page.route('**/*',route=>{assert.equal(new URL(route.request().url()).hostname,'127.0.0.1','不得外联');return route.continue();});
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   if(hold){await page.getByRole('status').waitFor();assert.match(await page.getByRole('status').textContent(),/正在读取/);hold=false;release();}
   const row=page.getByRole('row').filter({hasText:'沪TEST01'});await row.getByRole('button',{name:'明细',exact:true}).click();
   const section=page.getByRole('region',{name:'车辆系统操作'}),detail=page.locator('.rec-detail');await section.waitFor();
   assert.equal(await section.locator('.rec-operation').count(),2);const body=await detail.textContent();
   assert.match(body,/延长停车有效期/);assert.match(body,/关联任务#71/);assert.match(body,/等待执行回执/);assert.match(body,/日期不一致/);assert.match(body,/2027-10-30/);assert.match(body,/2027-10-31/);assert.match(body,/现场通行：未验证/);
   assert.ok(!/parkingSystems|parkingTarget|sourceRecordId|local:parking|\{"/.test(body));assert.ok(!body.includes('车位编号隔离'));
   const geometry=await detail.boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
   assert.ok(geometry.width<=width-30,JSON.stringify({geometry,width}));assert.ok(viewport.scroll<=width+1,JSON.stringify(viewport));
   await detail.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`records-operations-${width}.png`),fullPage:true,animations:'disabled'});
   await page.getByRole('row').filter({hasText:'沪TEST02'}).getByRole('button',{name:'明细',exact:true}).click();
   const manual=page.locator('.rec-detail').filter({hasText:'沪TEST02'});assert.match(await manual.textContent(),/人工登记办结/);assert.match(await manual.textContent(),/未记录分步结果/);assert.match(await manual.textContent(),/2026-11-15 08:00/,'纽约浏览器仍显示北京时间');assert.ok(!(await manual.textContent()).includes('已写入并回读'));
   await page.getByRole('row').filter({hasText:'沪TEST03'}).getByRole('button',{name:'明细',exact:true}).click();
   const registration=page.locator('.rec-detail').filter({hasText:'沪TEST03'});assert.match(await registration.textContent(),/车牌查重/);assert.match(await registration.textContent(),/新增车辆登记/);assert.match(await registration.textContent(),/执行失败/);assert.match(await registration.textContent(),/本轮处理结束/);assert.match(await registration.textContent(),/2026-11-15 08:10/);assert.equal(await registration.locator('.rec-operation').count(),4,'同库两个车库保持两项目标且无重复渲染key');
   await page.getByRole('textbox',{name:'办理记录搜索'}).fill('沪TEST01');fail=true;await page.getByRole('button',{name:'查询',exact:true}).click();
   await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('textbox',{name:'办理记录搜索'}).inputValue(),'沪TEST01');
   assert.equal(await page.locator('.rec-detail').count(),0,'失败不残留旧单明细');fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();
   await row.waitFor();assert.equal(await page.getByRole('button',{name:'明细',exact:true}).count(),1);await row.getByRole('button',{name:'明细',exact:true}).click();await page.getByRole('region',{name:'车辆系统操作'}).waitFor();
   await page.close();
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(evidence,'browser-verification.json'),JSON.stringify({result:'passed',widths:[1440,390],calls,errors,boundary:'Real React Records + BusinessLedgerService + isolated PGlite SQL; fixed auth fixture; no production, payment, assistant/device writes; no field access proof'},null,2));
 }finally{release();if(browser)await browser.close();await new Promise(r=>server.close(r));await db.close();}
});
