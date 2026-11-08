const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{createRequire}=require('node:module');
const app=path.resolve(__dirname,'..'),api=path.resolve(app,'../api'),ar=createRequire(path.join(api,'package.json'));
ar('ts-node').register({project:path.join(api,'tsconfig.json'),transpileOnly:true});
const {screenFixture}=require(path.join(api,'test/screen-decision-fixture.ts'));
const {ScreenSettingsController}=require(path.join(api,'src/modules/fees/screen-settings.controller.ts'));
const {ScreenSettingsService}=require(path.join(api,'src/modules/fees/screen-settings.service.ts'));
const {CollectionTargetsService}=require(path.join(api,'src/modules/fees/collection-targets.service.ts'));
const {buildScreenSummary}=require(path.join(api,'src/modules/fees/screen-summary.util.ts'));
const {JwtAuthGuard}=require(path.join(api,'src/modules/auth/jwt-auth.guard.ts')),{PermissionsGuard}=require(path.join(api,'src/modules/access/permissions.guard.ts')),{AccessService}=require(path.join(api,'src/modules/access/access.service.ts'));
const {Module,ValidationPipe}=ar('@nestjs/common'),{NestFactory}=ar('@nestjs/core');
const esbuild=createRequire(require.resolve('vite/package.json'))('esbuild'),pause=ms=>new Promise(r=>setTimeout(r,ms));
test('决策大屏真实浏览器：表单校验→实际API/PG→刷新回读→大屏，含桌面与窄屏',{timeout:120000},async()=>{
 const f=await screenFixture(),user={id:7,tenantId:1},scope={scopeAll:true};
 const access={hasPermission:AccessService.prototype.hasPermission,hasAnyPermission:AccessService.prototype.hasAnyPermission};
 class Fixture{};Module({controllers:[ScreenSettingsController],providers:[{provide:ScreenSettingsService,useValue:f.settings},{provide:CollectionTargetsService,useValue:f.targets},JwtAuthGuard,PermissionsGuard,{provide:AccessService,useValue:access}]})(Fixture);
 const server=await NestFactory.create(Fixture,{logger:false,abortOnError:false});
 for(const mod of server.container.getModules().values())for(const map of [mod.providers,mod.injectables])for(const w of map.values())if(w.instance instanceof JwtAuthGuard)w.instance.canActivate=ctx=>{const req=ctx.switchToHttp().getRequest();req.user=user;req.access={scopeAll:true,pages:{fees:{view:true,edit:req.headers['x-test-edit']==='yes'}}};return true;};
 server.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true}));
 const dir=path.resolve(app,'../../outputs/screen-decision-20261108');fs.mkdirSync(dir,{recursive:true});
 const build=esbuild.buildSync({entryPoints:[path.join(__dirname,'screen-browser.tsx')],bundle:true,format:'iife',jsx:'automatic',write:false,outfile:path.join(dir,'fixture.js'),alias:{'@/lib/auth':path.join(__dirname,'screen-browser-auth.ts'),'@/lib/perm':path.join(__dirname,'screen-browser-auth.ts'),'@':path.join(app,'src'),'@pms/api-client':path.join(__dirname,'screen-browser-api.ts'),'@pms/shared-types':path.resolve(app,'../../packages/shared-types/src/index.ts')},define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"'}});
 for(const out of build.outputFiles)fs.writeFileSync(out.path,out.contents);
 const express=server.getHttpAdapter().getInstance();
 express.use((req,res,next)=>{if(req.headers['x-test-fail']==='yes'&&req.path.startsWith('/fees/'))return res.status(503).json({message:'隔离测试：网络读取失败'});next();});
 express.get('/fees/mis/options',(_req,res)=>res.status(500).json({message:'大屏不得调用MIS选项接口'}));
 express.get('/fees/mis/screen-summary',async(req,res)=>{
   const cfg=await f.settings.read(user,scope,Number(req.query.year),req.query.communityIds);
   const now=new Date(),yr=Number(req.query.year),dailyRows=[];
   for(let m=0;m<12;m++)for(let d=1;d<=28;d++)dailyRows.push({officeCode:'01',day:`${yr}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,paidCents:270000,billCount:1,houseCount:1});
   const summary=buildScreenSummary({year:yr,now,granularity:'day',communities:cfg.communities.map(c=>({...c,offices:[String(c.id).padStart(2,'0')]})),targets:cfg.targets,dailyRows,arrears:{totalCents:0,houseCount:0,buckets:[]},recentPayments:[]});res.json({...summary,source:'fixture',queriedAt:now.toISOString()});
 });
 express.get('/fixture.js',(_q,r)=>r.type('js').send(fs.readFileSync(path.join(dir,'fixture.js'))));express.get('/fixture.css',(_q,r)=>r.type('css').send(fs.readFileSync(path.join(dir,'fixture.css'))));
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>';
 for(const p of ['/screen','/screen-settings'])express.get(p,(_q,r)=>r.type('html').send(html));
 await server.listen(0,'127.0.0.1');const base=await server.getUrl(),url=base+'/screen-settings?year=2026';
 const profile=path.join(dir,'chrome-'+Date.now()),child=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run',url],{stdio:'ignore'});let ws;
 try{
  for(let n=0;n<100&&!fs.existsSync(path.join(profile,'DevToolsActivePort'));n++)await pause(100);
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);let tabs;for(let n=0;n<50;n++){tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(tabs.find(t=>t.url===url))break;await pause(100);}
  ws=new WebSocket(tabs.find(t=>t.url===url).webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>reject(Error(method+' timeout')),12000);pending.set(n,m=>{clearTimeout(t);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id:n,method,params}));});
  const js=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
  const waitFor=async exp=>{for(let n=0;n<100;n++){if(await js(exp))return;await pause(100);}throw Error('wait timeout '+exp+' '+await js('document.body.innerText')); };
  const click=async selector=>{await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});e.click()})()`);await pause(200);};
  const fill=async(selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await waitFor("!!document.querySelector('#manual-asof')");
  assert.match(await js('document.body.textContent'),/预填值尚未保存/);
  await click('#target-new button[type=submit]');assert.equal(await js("document.querySelector('#target-new [aria-invalid=true]').tagName"),'SELECT');assert.ok(await js("document.activeElement.getAttribute('aria-invalid')==='true'"));
  await js("(()=>{const e=document.querySelector('#target-new-ids');e.options[0].selected=true;e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click('#target-new input[type=checkbox]');await click('#target-new button[type=submit]');await waitFor("document.body.textContent.includes('枫桦景苑一期')&&!!document.querySelector('#target-1')");
  await fill('#manual-overdueHouses','');await click('.ss-save button');assert.equal(await js('document.activeElement.id'),'manual-overdueHouses');assert.ok(await js("document.querySelector('#manual-overdueHouses-error').textContent.length>0"));
  await fill('#manual-overdueHouses','15');await fill('#owner-1','测试负责人');await click('.ss-save button');await waitFor("document.body.textContent.includes('人工指标和负责人已保存并回读')");
  assert.equal((await f.settings.read(user,scope,2026)).manual.overdueHouses,15);
  await js('window.__screenFail=true');await fill('#manual-overdueHouses','17');await click('.ss-save button');await waitFor("document.body.textContent.includes('网络读取失败')");assert.equal(await js("document.querySelector('#manual-overdueHouses').value"),'17');assert.equal((await f.settings.read(user,scope,2026)).manual.overdueHouses,15);await js('window.__screenFail=false');await fill('#manual-overdueHouses','15');await click('.ss-save button');await waitFor("document.body.textContent.includes('人工指标和负责人已保存并回读')");
  await call('Page.reload');await waitFor("document.querySelector('#manual-overdueHouses')?.value==='15'");assert.equal(await js("document.querySelector('#owner-1').value"),'测试负责人');
  const geometry=[];
  for(const width of [1440,390,320]){await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await js('window.scrollTo(0,0)');await pause(150);const g=await js('({width:innerWidth,scroll:document.documentElement.scrollWidth})');geometry.push({page:'settings',...g});assert.ok(g.scroll<=width+1,JSON.stringify(g));const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(dir,`settings-${width}.png`),Buffer.from(shot.data,'base64'));}
  await call('Page.navigate',{url:base+'/screen?year=2026'});await waitFor("document.body.textContent.includes('当前回款')");assert.match(await js('document.body.textContent'),/示例数据/);assert.match(await js('document.body.textContent'),/测试负责人/);assert.equal(await js("document.querySelector('.dec-actions strong').textContent"),'15户');
  assert.equal(await js("document.querySelectorAll('.dec-action-icon').length"),3);assert.ok(await js("[...document.querySelectorAll('.dec-action-icon')].every(e=>e.querySelector('path')&&e.getBoundingClientRect().width>=28)"));assert.equal(await js("document.querySelectorAll('.dec-chart-annotations text').length"),4);assert.match(await js("document.querySelector('.dec-chart-annotations').textContent"),/今日.*计划.*实收.*年末估算/);assert.equal(await js("document.querySelectorAll('.dec-legend span').length"),3);assert.match(await js("document.querySelector('.dec-notice').textContent"),/隔离测试数据/);
  assert.deepEqual(await js("[...document.querySelectorAll('.dec-month-label')].map(e=>e.textContent)"),Array.from({length:12},(_,i)=>`${i+1}月`));
  await js("document.querySelector('[data-chart-month=\"1\"]').focus()");
  await waitFor("!!document.querySelector('.dec-month-tooltip')");
  assert.match(await js("document.querySelector('.dec-month-tooltip').textContent"),/1月.*当月实收.*75,600.00.*年内累计.*75,600.00/);
  await js("document.querySelector('[data-chart-month=\"2\"]').focus()");
  assert.match(await js("document.querySelector('.dec-month-tooltip').textContent"),/2月.*75,600.00.*151,200.00/);
  await call('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  await js("document.querySelector('[data-chart-month=\"12\"]').scrollIntoView({block:'center'})");
  const monthPoint=await js("(()=>{const r=document.querySelector('[data-chart-month=\"12\"] rect').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...monthPoint});
  await waitFor("document.querySelector('.dec-month-tooltip')?.textContent.includes('12月')");
  assert.match(await js("document.querySelector('.dec-month-tooltip').textContent"),/尚未发生/);
  await js("document.querySelector('[data-chart-month=\"11\"]').focus()");
  await waitFor("document.querySelector('.dec-month-tooltip')?.textContent.includes('截至')");
  assert.match(await js("document.querySelector('.dec-month-tooltip').textContent"),/21,600.00.*777,600.00/);
  const tooltipShot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,'screen-month-tooltip.png'),Buffer.from(tooltipShot.data,'base64'));
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await waitFor("!document.querySelector('.dec-month-tooltip')");
  const toggleFullscreen=async()=>{const p=await js("(()=>{const e=document.querySelector('[aria-label=\"切换全屏\"]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p});};
  await toggleFullscreen();await waitFor("!!document.fullscreenElement||document.body.textContent.includes('浏览器未允许全屏')");if(await js('!!document.fullscreenElement')){await waitFor("document.querySelector('[aria-label=\"切换全屏\"]').textContent==='退出全屏'");assert.equal(await js("document.querySelector('[aria-label=\"切换全屏\"]').textContent"),'退出全屏');await toggleFullscreen();await waitFor("!document.fullscreenElement&&document.querySelector('[aria-label=\"切换全屏\"]').textContent==='全屏'");assert.equal(await js("document.querySelector('[aria-label=\"切换全屏\"]').textContent"),'全屏');}

  for(const [width,height]of [[1920,1080],[1440,900],[390,844],[320,900]]){await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await js('window.scrollTo(0,0)');await pause(150);const g=await js('({width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight,total:document.documentElement.scrollHeight,footerBottom:document.querySelector(".dec-footer").getBoundingClientRect().bottom})');if(width>=1100){assert.equal(g.height,g.total);assert.ok(g.footerBottom<=height+1);}geometry.push({page:'screen',...g});assert.ok(g.scroll<=width+1,JSON.stringify(g));const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,`screen-${width}.png`),Buffer.from(shot.data,'base64'));}
  await js('window.__screenFail=true');await click('[aria-label="刷新大屏"]');await waitFor("document.body.textContent.includes('经营数据读取失败')");assert.ok(!await js("document.body.textContent.includes('测试负责人')"),'失败后不能保留旧范围数字');assert.equal(await js("document.querySelector('.dec-notice>span').textContent"),'');
  fs.writeFileSync(path.join(dir,'geometry.json'),JSON.stringify(geometry,null,2));console.log('actual API + PGlite + Chromium evidence',dir,JSON.stringify(geometry));
 }finally{ws?.close();child.kill();await server.close();await f.pg.close();}
});
