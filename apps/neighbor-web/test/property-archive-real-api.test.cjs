const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const api = path.resolve(app, '../api');
const apiRequire = createRequire(path.join(api, 'package.json'));
const esbuild = createRequire(require.resolve('vite'))('esbuild');

// No API/auth/permission/surface replacement. The only infrastructure is a localhost static host
// + reverse proxy to the actual Nest controllers, real Passport JWT and SQL-backed AccessService.
// Only session issuance is test-only; auth/me and ui-preferences use real AuthController/AuthService.
// Default: unmodified Vite dist index/assets and real main/App/Shell/router for archive/permission routes.
// PMS_ARCHIVE_SOURCE=1 supports earlier source-only diagnostic coverage. Contacts remain direct component.
// DB engine is PGlite; password/QR login and native PostgreSQL concurrency are not covered.
test('真实React/主题/权限→JWT API→SQL：层级、全部业主、房产保存刷新、多号码明确确认、只读/无页面权限', {timeout:180000}, async () => {
  const useDist=process.env.PMS_ARCHIVE_SOURCE!=='1';
  const out = path.resolve(app, '../../outputs/current-task-recovery-20261112',...(useDist?['vite-artifact']:[]));
  fs.mkdirSync(out,{recursive:true});
  const ready = path.join(out,`real-api-${process.pid}-${Date.now()}.json`);
  const log = fs.openSync(path.join(out,'real-api-server.log'),'w');
  const child = spawn(process.execPath,['-r',apiRequire.resolve('ts-node/register'),'src/modules/owners-mgmt/property-archive.integration.test.ts','--serve',ready],{cwd:api,stdio:['ignore',log,log]});
  let browser,server,page;
  const errors=[],calls=[],servedArtifacts={};
  try {
    let boot;
    for(let i=0;i<600;i++) {
      if(fs.existsSync(ready)){boot=JSON.parse(fs.readFileSync(ready,'utf8'));break;}
      if(child.exitCode!==null) throw Error(`API bootstrap exited ${child.exitCode}: ${fs.readFileSync(path.join(out,'real-api-server.log'),'utf8')}`);
      await delay(100);
    }
    assert.ok(boot,'API did not become ready');
    const distDir=path.join(app,'dist');
    const distIndex=useDist?fs.readFileSync(path.join(distDir,'index.html'),'utf8'):'';
    const distBase=useDist?/src=["']([^"']*\/)assets\//.exec(distIndex)?.[1]:null;
    assert.ok(!useDist||distBase,'Vite artifact must have a known same-origin assets base');
    const housesPath=useDist?distBase+'houses':'/houses';
    const built = await esbuild.build({
      stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';
        import {configureApi} from '@/lib/api';import {auth} from '@/lib/auth';import UiPreferencesProvider from '@/components/UiPreferencesProvider';
        import App from '@/App';import {IconSprite} from '@/components/Icon';import OwnerBusinessContact from '@/components/OwnerBusinessContact';
        import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';
        configureApi();
        async function login(id){const r=await fetch('/_api/__test-session?actor='+id);if(!r.ok)throw Error('session bootstrap');const s=await r.json();auth.setLogin(s);auth.setAccess(s.access,auth.captureIdentity());return s;}
        window.__testLogin=login;
        const actor=new URLSearchParams(location.search).get('actor');
         (actor||!auth.getToken()?login(actor||100):Promise.resolve()).then(()=>createRoot(document.getElementById('root')).render(<><IconSprite/><BrowserRouter><UiPreferencesProvider>{location.pathname==='/contacts'?<OwnerBusinessContact houseId={1} preferredOwnerId={${boot.ownerId}} source="cashier"/>:<App/>}</UiPreferencesProvider></BrowserRouter></>)).catch(e=>{document.body.textContent=e.message;throw e});`,loader:'tsx',resolveDir:app},
      bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.woff2':'dataurl'},outfile:'entry.js',alias:{'@':path.join(app,'src')},
      define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_API_BASE_URL':'"/_api"','import.meta.env.VITE_LEGACY_BASE':'""'},
    });
    server=http.createServer(async(req,res)=>{
      try {
        const apiPrefix=req.url.startsWith('/_api/')?'/_api':req.url.startsWith('/api/v1/')?'/api/v1':null;
        if(apiPrefix) {
          const chunks=[];for await(const chunk of req)chunks.push(chunk);
          const body=Buffer.concat(chunks);
          const upstream=await fetch(boot.base+req.url.slice(apiPrefix.length),{method:req.method,headers:Object.fromEntries(['authorization','content-type','x-acting-tenant-id','x-acting-office-id','x-client-source'].filter(key=>req.headers[key]).map(key=>[key,req.headers[key]])),...(body.length?{body}: {})});
          const text=await upstream.text();
          calls.push({url:req.url,method:req.method,status:upstream.status,...(body.length?{data:JSON.parse(body)}:{})});
          res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(text);return;
        }
        if(useDist&&req.url!=='/entry.js'&&req.url!=='/entry.css'&&!req.url.startsWith('/contacts')) {
          const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
          const relative=pathname.startsWith(distBase)?pathname.slice(distBase.length):null;
          const file=relative!==null&&relative.startsWith('assets/')?path.resolve(distDir,relative):path.join(distDir,'index.html');
          if(!file.startsWith(distDir+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end('missing asset');return;}
          const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
          const content=fs.readFileSync(file);servedArtifacts[path.relative(distDir,file)]=createHash('sha256').update(content).digest('hex');
          res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(content);return;
        }
        const ext=req.url==='/entry.js'?'js':req.url==='/entry.css'?'css':'html';
        res.setHeader('Content-Type',{js:'text/javascript',css:'text/css',html:'text/html; charset=utf-8'}[ext]);
        res.end(ext==='html'?'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root" style="padding:20px"></div><script src="/entry.js"></script>':built.outputFiles.find(f=>f.path.endsWith('.'+ext)).contents);
      } catch(error){res.writeHead(500);res.end(JSON.stringify({message:error.message}));}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    page=await browser.newPage({viewport:{width:1920,height:1080}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
    if(useDist) {
      const sessions=Object.fromEntries(await Promise.all([100,101,102].map(async actor=>{const r=await fetch(boot.base+'/__test-session?actor='+actor);assert.equal(r.status,200);return [actor,await r.json()];})));
      await page.addInitScript(({sessions})=>{
        const actor=new URLSearchParams(location.search).get('actor');
        if(actor||!sessionStorage.getItem('pms.admin.token')) {
          const session=sessions[actor||100];
          for(const key of ['pms.admin.token','pms.admin.user','pms.admin.access','pms.admin.actingTenant','pms.admin.actingOffice']) sessionStorage.removeItem(key);
          sessionStorage.setItem('pms.admin.token',session.accessToken);sessionStorage.setItem('pms.admin.user',JSON.stringify(session.user));
        }
      },{sessions});
    }
    const row=text=>page.locator('.pa-desktop').getByRole('row').filter({hasText:text});
    const save=()=>page.locator('.ant-modal:visible .ant-modal-footer .ant-btn-primary').click();
    const read=path=>page.evaluate(async path=>{const r=await fetch('/_api'+path,{headers:{Authorization:'Bearer '+sessionStorage.getItem('pms.admin.token')}});if(!r.ok)throw Error('API '+r.status);return r.json();},path);
    await page.goto(origin+housesPath);
    await page.locator('.pa-office header').getByRole('button',{name:'测试管理处',exact:true}).click();
    await row('测试一期').getByRole('button',{name:'查看下级'}).click();
    await row('3号').getByRole('button',{name:'查看房号'}).click();
    await row('101').getByRole('button',{name:/^编\s*辑$/,exact:true}).click();
    await page.getByLabel('楼层',{exact:true}).fill('3');await page.getByLabel('房产备注',{exact:true}).fill('真实浏览器保存');
    await save();await page.getByRole('dialog').waitFor({state:'hidden'});
    let houses=await read('/houses?id=1&buildingId=1');assert.equal(houses[0].floor,'3');assert.equal(houses[0].remark,'真实浏览器保存');
    await page.reload();await row('101').getByText('3',{exact:true}).waitFor();
    await row('101').getByRole('button',{name:'查看业主'}).click();
    await row('已有业主甲').waitFor();await row('已有业主乙').waitFor();
    await row('已有业主甲').getByText('021-12345678',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'real-api-all-owners.png'),animations:'disabled'});
    await page.goto(origin+'/contacts');
    await page.getByRole('button',{name:/业务联系人/}).click();
    await page.getByLabel('业主姓名',{exact:true}).fill('真实浏览器联系人');
    await page.getByRole('button',{name:'保存联系人与本次确认',exact:true}).click();
    await page.getByRole('status').getByText(/联系人已保存/).waitFor();
    let owners=await read('/owners-mgmt/business-contacts?houseId=1');
    let owner=owners.find(o=>o.id===boot.ownerId);assert.equal(owner.name,'真实浏览器联系人');assert.ok(owner.phoneActivity.every(p=>!p.last_confirmed_at));
    await page.getByRole('checkbox',{name:'本次已核实 021-12345678',exact:true}).check();
    await page.getByRole('button',{name:'保存联系人与本次确认',exact:true}).click();
    await page.getByRole('status').getByText(/联系人已保存/).waitFor();
    await page.reload();await page.getByRole('button',{name:/业务联系人/}).click();
    await page.getByLabel('业主姓名',{exact:true}).waitFor();assert.equal(await page.getByLabel('业主姓名',{exact:true}).inputValue(),'真实浏览器联系人');
    owners=await read('/owners-mgmt/business-contacts?houseId=1');owner=owners.find(o=>o.id===boot.ownerId);
    assert.ok(owner.phoneActivity.find(p=>p.phone==='021-12345678').last_confirmed_at);
    assert.deepEqual([...new Set([owner.phone,...owner.contactPhones])].sort(),['021-12345678','13800000001'].sort());
     const primaryActivity=owner.phoneActivity.find(p=>p.phone==='13800000001');assert.ok(primaryActivity);assert.ok(primaryActivity.last_confirmed_at==null,'主号未显式核实，不能有确认日期');
    assert.equal(owner.properties.length,2);
    await page.screenshot({path:path.join(out,'real-api-contact-confirmed.png'),animations:'disabled'});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(out,'real-api-contact-mobile.png'),animations:'disabled'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.goto(origin+'/contacts?actor=101');await page.getByRole('button',{name:/业务联系人/}).click();
    await page.getByLabel('业主姓名',{exact:true}).waitFor();assert.equal(await page.getByLabel('业主姓名',{exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'保存联系人与本次确认',exact:true}).count(),0);
    await page.goto(origin+housesPath+'?actor=102');await page.getByText('当前账号未获授任何后台页面权限，请联系管理员。',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'real-api-no-permission.png'),animations:'disabled'});
    assert.deepEqual(errors,[]);
    if(useDist) {
      assert.ok(servedArtifacts['index.html']);
      assert.ok(Object.keys(servedArtifacts).some(name=>/^assets[\\/]index-.*\.js$/.test(name)),'real Vite main bundle must be served');
      assert.equal((await fetch(origin+distBase+'assets/__missing_test_artifact__.js')).status,404,'missing assets must not fall back to HTML');
    }
    assert.ok(calls.some(c=>c.method==='PATCH'&&/^\/(?:_api|api\/v1)\/houses\/1$/.test(c.url)&&c.status===200));
    assert.ok(calls.some(c=>/^\/(?:_api|api\/v1)\/auth\/me$/.test(c.url)&&c.status===200));
    const unconfiguredShellDependencies=calls.filter(c=>c.status>=400);
    assert.ok(unconfiguredShellDependencies.every(c=>c.status===404&&/^\/(?:_api|api\/v1)\/(?:notifications\/unread-count|telemetry\/page-views?)$/.test(c.url)),JSON.stringify(unconfiguredShellDependencies));
    fs.writeFileSync(path.join(out,'real-api-browser-evidence.json'),JSON.stringify({engine:boot.engine,auth:'real JwtStrategy + SQL AccessService + AuthController/AuthService; test-only session issuance (not password/QR login)',entry:useDist?'unmodified Vite dist + main/App/Shell/router/configureApi; contacts direct source component; test-only signed session bootstrap':'real App/Shell/router/configureApi source via esbuild; contacts direct component; not Vite artifact',servedArtifacts,unconfiguredShellDependencies,calls,errors},null,2));
  } catch(error) {
    if(page){await page.screenshot({path:path.join(out,'real-api-browser-failure.png'),animations:'disabled'});fs.writeFileSync(path.join(out,'real-api-browser-failure.html'),await page.content());}
    throw error;
  } finally {
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    child.kill();fs.closeSync(log);
  }
});
