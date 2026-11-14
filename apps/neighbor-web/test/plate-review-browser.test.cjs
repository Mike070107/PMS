const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const evidence = path.resolve(app, '../../outputs/plate-review-ui-20261111');
const esbuild = createRequire(require.resolve('vite'))('esbuild');

// Only transport/auth are isolated. Both the formal NewPlateCard and Plates manage entry are real React.
async function fixture() {
  const built = await esbuild.build({
    stdin: { contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import{BrowserRouter}from'react-router-dom';
      import NewPlateCard from '@/components/cashier/NewPlateCard';import Plates from '@/pages/Plates';import {IconSprite} from '@/components/Icon';
      import {seed,targets} from '@pms/api-client';
      import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';import '@/styles/erp-reference.css';
      function Fixture(){const [it,setIt]=useState(seed);return <main style={{maxWidth:1200,margin:'0 auto',padding:16}}><IconSprite/><p>显式示例 · 非真实住户资料</p>{location.search.includes('entry')?<Plates/>:<NewPlateCard intake={it} house={{id:1,communityId:1,lane:'198',buildingNo:'示例',roomNo:'示例'}} rules={[]} targets={targets} manage onChange={setIt} onDrop={()=>{}} onCart={()=>{}} renewal={()=>null}/>}</main>};createRoot(document.getElementById('root')).render(<BrowserRouter><Fixture/></BrowserRouter>);`, loader: 'tsx', resolveDir: app },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile: 'fixture.js',
    alias: { '@': path.join(app, 'src') },
    plugins: [{ name: 'isolated-transport', setup(build) {
      build.onResolve({ filter: /^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        if (args.path.endsWith('/perm')) return { contents: 'export const can=()=>true;', loader: 'js' };
        if (args.path.endsWith('/auth')) return { contents: 'export const useSession=()=>({user:{id:1}});', loader: 'js' };
        return { loader: 'js', contents: `
          const params=new URLSearchParams(location.search);const state=params.get('state')||'submitted';
          export const targets=[{key:'phase1',label:'示例小区 一期地面',short:'一期地面',system:'local',billing:'vehicle',communities:['示例小区']},{key:'phase2',label:'示例小区 二期地面',short:'二期地面',system:'local',billing:'vehicle',communities:['示例小区']},{key:'main',label:'示例小区 二期大车库',short:'二期大车库',system:'local',billing:'space',communities:['示例小区']},{key:'civil',label:'示例小区 二期人防车库',short:'二期人防车库',system:'local',billing:'space',communities:['示例小区']}];
          export const seed={id:61,kind:params.get('kind')||'family',status:state==='waiting'?'waiting':state==='reupload'?'reupload':state==='void'?'void':state==='submitted'?'submitted':'approved',houseId:1,houseLabel:'示例小区/198弄/示例室',ownerName:'示例住户',ownerPhone:'',plate:'示例车牌',contactName:'示例联系人',contactPhone:'',relation:'父母',vehicleClass:'示例类别',garages:['phase1'],garageNumbers:{},expiresAt:'2099-11-11T23:59:00+08:00',qrValid:true,openedAt:state==='waiting'||params.has('noOpened')?null:'2026-11-11T09:01:00+08:00',submittedAt:state==='waiting'?null:'2026-11-11T09:05:00+08:00',reviewedAt:['submitted','waiting'].includes(state)?null:'2026-11-11T09:10:00+08:00',reviewNote:state==='reupload'?'示例：请补清晰照片':'',files:[{index:0,fileName:'示例资料正面.svg',contentType:'image/svg+xml',fileUrl:'/sample-front.svg',uploadedAt:''},{index:1,fileName:'示例资料背面.svg',contentType:'image/svg+xml',fileUrl:'/sample-back.svg',uploadedAt:''},{index:2,fileName:'示例损坏图片.png',contentType:'image/png',fileUrl:'/broken.png',uploadedAt:''},{index:3,fileName:'示例原始附件.pdf',contentType:'application/pdf',fileUrl:'/original.pdf?token=fixture',uploadedAt:''}],transaction:params.has('txn')?{id:1,txnNo:'EXAMPLE',amountCents:10000,startDate:'2026-11-11',endDate:'2027-11-11',externalSyncStatus:params.get('txn'),execution:null}:null,familyCarId:state==='family-pending'?61:null,createdAt:'2026-11-11T09:00:00+08:00',qr:{url:location.origin+'/example-qr',dataUrl:'/sample-qr.svg',expiresAt:'2099-11-11T23:59:00+08:00'},log:[{at:'2026-11-11T09:00:00+08:00',userName:'示例办公室',action:'创建示例登记'}]};
          let current=structuredClone(seed);window.__calls=[];window.__failGarage=false;window.__delayGarage=0;
          export const accessCardIssuance={createParkingQuery:async()=>({id:1,status:'completed'}),parkingQuery:async()=>({id:1,status:'completed'})};
          export async function request({url,method='GET',data={}}){window.__calls.push({url,method,data});
            if(url==='/business/parking-targets')return targets;
            if(url==='/vehicle-intakes')return [current];
            if(url.endsWith('/garages')){if(window.__delayGarage)await new Promise(r=>setTimeout(r,window.__delayGarage));if(window.__failGarage)throw Error('示例：车库保存失败，请重试');current={...current,...data};}
            if(url.endsWith('/review'))current={...current,status:data.decision==='approve'?'approved':data.decision,reviewedAt:'2026-11-11T09:10:00+08:00'};
            return structuredClone(current);
          }` };
      });
    } }], define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"' },
  });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/sample-')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="640"><rect width="1000" height="640" fill="${req.url.includes('back') ? '#edf2f8' : '#e4efed'}"/><rect x="45" y="45" width="910" height="550" rx="24" fill="white" stroke="#31558a" stroke-width="4"/><text x="100" y="180" font-family="sans-serif" font-size="48" fill="#243f69">EXPLICIT SAMPLE ONLY</text><text x="100" y="280" font-family="sans-serif" font-size="32" fill="#46566b">${req.url.includes('back') ? 'BACK' : req.url.includes('qr') ? 'QR DEMO' : 'FRONT'} / NO RESIDENT IDENTITY</text><path d="M100 390h680m-680 70h440" stroke="#8fa6c7" stroke-width="20"/></svg>`);return;
    }
    if (req.url.startsWith('/broken')) { res.writeHead(404);res.end('fixture broken image');return; }
    if (req.url.startsWith('/original.pdf')) { res.setHeader('Content-Type','application/pdf');res.end('%PDF-1.4\n% explicit sample only');return; }
    const ext = req.url === '/fixture.js' ? 'js' : req.url === '/fixture.css' ? 'css' : 'html';
    res.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html; charset=utf-8' }[ext]);
    res.end(ext === 'html' ? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' : built.outputFiles.find(f => f.path.endsWith('.' + ext)).contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(4000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', r => r.request().url().startsWith(origin + '/') ? r.continue() : r.abort());
  return { page, origin, close: async () => { await browser.close();await new Promise(resolve => server.close(resolve)); } };
}
const lastPayload = page => page.evaluate(() => window.__calls.filter(c => c.url.endsWith('/garages')).at(-1));
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); }

test('family and paid native multi-checkbox retain dependency and POST payload; failures retain selection', async () => {
  const f = await fixture();const {page,origin}=f;
  try {
    for (const kind of ['family','paid']) {
      await page.goto(origin+'/?kind='+kind);
      assert.equal(await page.getByRole('checkbox').count(),4,kind+' real checkboxes');
      await page.getByRole('checkbox',{name:'二期大车库',exact:true}).check();
      await page.getByRole('checkbox',{name:'二期人防车库',exact:true}).check();
      assert.deepEqual(new Set((await lastPayload(page)).data.garages),new Set(['phase1','phase2','main','civil']));
      assert.equal((await lastPayload(page)).method,'POST');assert.equal((await lastPayload(page)).url,'/vehicle-intakes/61/garages');
      await page.getByRole('checkbox',{name:'二期地面',exact:true}).uncheck();
      assert.deepEqual((await lastPayload(page)).data,{garages:['phase1'],garageNumbers:{}});
      await page.getByRole('checkbox',{name:'二期大车库',exact:true}).check();
      if(kind==='family') {await page.getByLabel('大车库车库号',{exact:true}).fill('示例A01');await page.getByLabel('大车库车库号',{exact:true}).blur();assert.equal((await lastPayload(page)).data.garageNumbers.main,'示例A01');}
      await page.evaluate(()=>{window.__failGarage=true;});
      await page.getByRole('checkbox',{name:'二期人防车库',exact:true}).check();
      await page.getByText('示例：车库保存失败，请重试',{exact:true}).waitFor();
      assert.equal(await page.getByRole('checkbox',{name:'二期人防车库',exact:true}).isChecked(),true);
      assert.equal(await page.getByRole('button',{name:'资料无误，通过',exact:true}).isDisabled(),true);
      fs.mkdirSync(evidence,{recursive:true});
      if(kind==='paid')await page.screenshot({path:path.join(evidence,'paid-save-error-1440.png'),fullPage:true});
      await page.evaluate(()=>{window.__failGarage=false;window.__delayGarage=250;});
      await page.getByRole('button',{name:'重试保存授权',exact:true}).click();
      await page.getByText('正在保存授权…',{exact:true}).waitFor();
      assert.equal(await page.getByRole('checkbox',{name:'二期人防车库',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'资料无误，通过',exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('fieldset').getAttribute('aria-busy')||document.querySelector('fieldset').getAttribute('aria-busy')==='false');
      assert.deepEqual(new Set((await lastPayload(page)).data.garages),new Set(['phase1','phase2','main','civil']));
      assert.equal(await page.getByRole('checkbox',{name:'二期人防车库',exact:true}).isEnabled(),true);
      if(kind==='paid')for(const width of [1440,390]){await page.setViewportSize({width,height:900});await noOverflow(page);await page.screenshot({path:path.join(evidence,`paid-review-${width}.png`),fullPage:true});}
      await page.getByRole('button',{name:'资料无误，通过',exact:true}).click();
      await page.waitForFunction(()=>window.__calls.some(c=>c.url.endsWith('/review')));
      const review=await page.evaluate(()=>window.__calls.filter(c=>c.url.endsWith('/review')).at(-1));
      assert.equal(review.method,'POST');assert.equal(review.data.decision,'approve');assert.deepEqual(new Set(review.data.garages),new Set(['phase1','phase2','main','civil']));
    }
  } finally {await f.close();}
});

test('four connected workflow nodes show recorded times and never equate payment or family handoff with activation', async () => {
  const f=await fixture();const {page,origin}=f;
  try {
    const cases=[['?state=waiting',['等待扫码','待填写上传','待办公室审核','待经理审核']],['?state=submitted',['09:01','09:05','待办公室审核','待经理审核']],['?state=submitted&noOpened=1',['未记录扫码时间','09:05','待办公室审核','待经理审核']],['?state=reupload',['09:01','09:05','已退回','待经理审核']],['?state=family-pending',['09:01','09:05','已通过','待经理审核']],['?kind=paid&state=approved&txn=queued',['09:01','09:05','已通过','排队办理中']],['?kind=paid&state=approved&txn=failed',['09:01','09:05','已通过','办理失败']],['?kind=paid&state=approved&txn=synced',['09:01','09:05','已通过','已生效']],['?kind=paid&state=void&txn=synced',['09:01','09:05','已作废','登记已作废']],['?kind=paid&state=approved&txn=dry_run',['09:01','09:05','已通过','演练完成（未真正写入）']]];
    for(const [query,values] of cases){await page.goto(origin+'/'+query);const steps=page.getByRole('list',{name:'车牌登记办理流程'});assert.equal(await steps.locator('li').count(),4);assert.equal(await steps.locator('.np-step-arrow').count(),3);for(let i=0;i<4;i++)assert.ok((await steps.locator('li').nth(i).innerText()).includes(values[i]),query+' step '+i);if(query.includes('queued')||query.includes('family-pending')||query.includes('void')||query.includes('dry_run'))assert.notEqual(await steps.locator('li').last().getAttribute('data-state'),'done');}
  }finally{await f.close();}
});

test('image lightbox zoom, gallery, broken image, PDF original, Escape/backdrop/focus trap and 1440/390 screenshots', async () => {
  const f=await fixture();const {page,origin}=f;
  fs.mkdirSync(evidence,{recursive:true});
  try {
    await page.goto(origin+'/?entry=1');
    await page.getByRole('row').filter({hasText:'示例车牌'}).click();
    await page.getByRole('checkbox',{name:'二期大车库',exact:true}).check();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:width===390?844:1000});await noOverflow(page);
      assert.ok((await page.locator('.ph').boundingBox()).height < 280, 'responsive header must not turn horizontal flex bases into hundreds of pixels of blank height');
      assert.ok(await page.locator('.np-review, .np-garage-options, .np-review-steps').evaluateAll(nodes=>nodes.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})),width+' formal card must not be clipped by parent table');
      assert.ok(await page.locator('.np-review .np-garage-option').evaluateAll(nodes=>nodes.every(n=>{const r=n.getBoundingClientRect();return r.height>=44&&r.left>=0&&r.right<=innerWidth;})),width+' checkbox touch targets visible');
      if(width===1440){const boxes=await page.locator('.np-fields label').evaluateAll(ns=>ns.slice(0,3).map(n=>{const r=n.getBoundingClientRect();return {y:r.y,width:r.width};}));assert.equal(boxes.length,3);assert.ok(boxes.every(b=>Math.abs(b.y-boxes[0].y)<1&&b.width<=221),'three compact aligned fields');}
      await page.screenshot({path:path.join(evidence,`review-${width}.png`),fullPage:true});
      const opener=page.getByRole('button',{name:'预览图片：示例资料正面.svg',exact:true});await opener.click();
      const dialog=page.getByRole('dialog',{name:'登记资料图片预览'});await dialog.waitFor();
      const before=await dialog.locator('.np-preview-zoom').boundingBox();
      assert.equal(await dialog.locator('.np-preview-tools').count(),0,'no toolbar');
      const stage=dialog.locator('.np-preview-stage');await stage.hover();await page.mouse.wheel(0,-100);
      await page.waitForFunction(()=>document.querySelector('.np-preview-footer output').textContent==='120%');
      assert.ok((await dialog.locator('.np-preview-zoom').boundingBox()).width>before.width*1.19,'wheel changes actual image geometry');
      const area=await stage.boundingBox();await page.mouse.move(area.x+area.width/2,area.y+area.height/2);await page.mouse.down();await page.mouse.move(area.x+area.width/2+40,area.y+area.height/2+25);await page.mouse.up();
      const moved=await dialog.locator('.np-preview-zoom').boundingBox();assert.ok(moved.x>before.x-0.1*before.width+35,'pointer drag pans image');
      await page.keyboard.press('0');assert.equal(await dialog.locator('output').innerText(),'100%');
      assert.ok(Math.abs((await dialog.locator('.np-preview-zoom').boundingBox()).x-before.x)<1,'reset clears pan');
      for(let i=0;i<30;i++)await page.keyboard.press('+');assert.equal(await dialog.locator('output').innerText(),'500%');
      for(let i=0;i<30;i++)await page.keyboard.press('-');assert.equal(await dialog.locator('output').innerText(),'50%');
      await page.keyboard.press('0');
      const nav=await dialog.getByRole('button',{name:'下一张',exact:true}).boundingBox();assert.ok(nav.y>area.y&&nav.y<area.y+area.height,'navigation floats over image');
      assert.ok((await dialog.boundingBox()).width>width-65,'large preview fills viewport');
      await page.getByRole('button',{name:'下一张',exact:true}).click();assert.ok((await dialog.innerText()).includes('示例资料背面.svg'));
      await page.keyboard.press('ArrowLeft');assert.ok((await dialog.innerText()).includes('示例资料正面.svg'));
      await noOverflow(page);
      assert.ok(await dialog.locator('button').evaluateAll(bs=>bs.filter(b=>!b.disabled).every(b=>{const r=b.getBoundingClientRect();return r.height>=44&&r.width>=44;})));
      for(let i=0;i<18;i++){await page.keyboard.press('Tab');assert.equal(await dialog.evaluate(d=>d.contains(document.activeElement)),true);}
      await page.getByRole('button',{name:'关闭图片预览',exact:true}).focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.getByRole('button',{name:'下一张',exact:true}).evaluate(e=>document.activeElement===e),true);
      assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
      await page.screenshot({path:path.join(evidence,`preview-${width}.png`)});
      await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await opener.evaluate(e=>e===document.activeElement),true);
      await opener.click();await page.mouse.click(2,2);assert.equal(await dialog.count(),0);assert.equal(await opener.evaluate(e=>e===document.activeElement),true);
    }
    await page.getByRole('button',{name:'预览图片：示例损坏图片.png',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'图片加载失败'}).waitFor();
    assert.equal(await page.getByRole('link',{name:'打开原图',exact:true}).count(),0);
    await page.screenshot({path:path.join(evidence,'preview-error-390.png')});await page.keyboard.press('Escape');
    const pdf=page.getByRole('link',{name:'打开原附件：示例原始附件.pdf',exact:true});assert.equal(await pdf.getAttribute('href'),'/original.pdf?token=fixture');assert.equal(await pdf.getAttribute('target'),'_blank');assert.equal(await pdf.getAttribute('rel'),'noreferrer');
    await page.goto(origin+'/?state=waiting');
    const qr=page.getByRole('button',{name:'放大扫码登记二维码',exact:true});await qr.click();
    const qrDialog=page.getByRole('dialog',{name:'扫码登记二维码',exact:true});await qrDialog.waitFor();
    assert.equal(await qrDialog.getByRole('button',{name:'下一张',exact:true}).count(),0);
    await page.getByRole('button',{name:'关闭图片预览',exact:true}).click();assert.equal(await qrDialog.count(),0);assert.equal(await qr.evaluate(e=>e===document.activeElement),true);
  } finally {await f.close();}
});
