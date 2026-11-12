const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');

// Isolated browser interaction regression for the real production components. API responses here are
// deterministic fixtures, NOT evidence of API/database persistence (covered by the API SQL/HTTP suite).
test('A 档案正式组件：逐级路径、分期/弄号、全部业主、多电话日期、失败保留、刷新/返回及窄屏；共享联系人逐号确认', async () => {
  const built = await esbuild.build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import PropertyArchive from '@/pages/PropertyArchive';import OwnerBusinessContact from '@/components/OwnerBusinessContact';
      import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';
      createRoot(document.getElementById('root')).render(<BrowserRouter>{location.pathname==='/contacts'?<OwnerBusinessContact houseId={1} source={new URLSearchParams(location.search).get('source')==='parking'?'parking':'cashier'}/>:<PropertyArchive/>}</BrowserRouter>);`, loader:'tsx', resolveDir:app },
    bundle:true, write:false, format:'iife', jsx:'automatic', outfile:'fixture.js', alias:{'@':path.join(app,'src')},
    plugins:[{name:'isolated-adapters',setup(build){
      build.onResolve({filter:/^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm|@\/components\/MigratedSurface)$/},args=>({path:args.path,namespace:'fixture'}));
      build.onLoad({filter:/.*/,namespace:'fixture'},args=>{
        if(args.path.endsWith('/perm'))return {contents:`const readOnly=new URLSearchParams(location.search).has('readonly');export const can=(p,a='view')=>a==='view'||!readOnly;`,loader:'js'};
        if(args.path.endsWith('/auth'))return {contents:`import {useSyncExternalStore} from 'react';window.__session={user:{id:1},access:{isTenantAdmin:true}};const subscribe=cb=>{window.addEventListener('fixture-scope',cb);return()=>window.removeEventListener('fixture-scope',cb)};export const useSession=()=>useSyncExternalStore(subscribe,()=>window.__session);`,loader:'js',resolveDir:app};
        if(args.path.endsWith('/MigratedSurface'))return {contents:`import React from 'react';import {App,ConfigProvider} from 'antd';import zhCN from 'antd/es/locale/zh_CN';import '@/styles/migrated-surface.css';export default function Surface({children}){return <ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#31558a',fontSize:16,controlHeight:44,borderRadius:8}}}><App><section className="migrated-surface">{children}</section></App></ConfigProvider>}`,loader:'tsx',resolveDir:app};
        return {loader:'js',contents:`
          const seed={offices:[{id:1,name:'测试管理处',enabled:true}],communities:[{id:10,name:'枫桦景苑',isGroup:true,officeId:1},{id:1,name:'枫桦景苑一期',parentId:10,communityType:'community'},{id:2,name:'枫桦景苑二期',parentId:10,communityType:'community'}],buildings:[{id:1,communityId:1,buildingNo:'3号楼',lane:'198弄',buildingType:'residential'},{id:2,communityId:2,buildingNo:'3',lane:'228弄',buildingType:'residential'},{id:3,communityId:1,buildingNo:'沿街商铺',buildingType:'shop'}],houses:[{id:1,buildingId:1,roomNo:'101室',floor:'1',areaSqm:'89.50',propertyNature:'公房',roomLayout:'两室一厅',remark:'真实字段回读示例'},{id:2,buildingId:1,roomNo:'102',floor:null,propertyNature:null},{id:3,buildingId:2,roomNo:'101'}],owners:[{id:1,name:'已有业主甲',phone:'13800000001',contactPhones:['13800000001','021-12345678'],status:'active'},{id:2,name:'已有业主乙',phone:'13800000002',contactPhones:['13800000002'],status:'active'}],links:[{ownerId:1,houseId:1,moveInDate:'2026-11-01',billingStartDate:'2026-11-10'},{ownerId:1,houseId:3},{ownerId:2,houseId:1}]};
          let db=JSON.parse(localStorage.getItem('archive-fixture')||'null')||seed;window.__calls=[];window.__failWrite=false;window.__failRead=false;window.__delayRead=0;window.__readRules=[];window.__settledReadRules=[];
          const enriched=o=>({...o,properties:db.links.filter(l=>l.ownerId===o.id).map(l=>{const h=db.houses.find(h=>h.id===l.houseId);const b=db.buildings.find(b=>b.id===(h?.buildingId||l.ownerBuildingId));return {house_id:l.houseId,building_id:l.ownerBuildingId,community_id:b?.communityId,resolved_building_id:b?.id,community_name:db.communities.find(c=>c.id===b?.communityId)?.name,building_no:b?.buildingNo,room_no:h?.roomNo,move_in_date:l.moveInDate,billing_start_date:l.billingStartDate};})});
          export async function request({url,method='GET',query={},data={}}){
            window.__calls.push({url,method,query,data});
            if(method==='GET'){
              const index=window.__readRules.findIndex(r=>r.url===url&&(!r.communityId||r.communityId===query.communityId)&&(!r.buildingId||r.buildingId===query.buildingId));
              if(index>=0){const [rule]=window.__readRules.splice(index,1);if(rule.delay)await new Promise(r=>setTimeout(r,rule.delay));window.__settledReadRules.push(rule.id);if(rule.fail)throw Error('合成目标列表失败');if(rule.rows)return rule.rows;}
            }
            if(method==='GET'&&window.__delayRead)await new Promise(r=>setTimeout(r,window.__delayRead));
            if(method==='GET'&&window.__failRead){window.__failRead=false;throw Error('合成读取失败，请重试');}
            if(method!=='GET'&&window.__failWrite){window.__failWrite=false;throw Error('合成保存失败，输入已保留');}
            if(url==='/communities/offices')return db.offices;
            const [kind,id,action]=url.slice(1).split('/'),key=kind==='owners-mgmt'?'owners':kind;
            if(method==='GET'){
              let rows=[...(db[key]||[])];if(query.id)rows=rows.filter(r=>r.id===query.id);
              if(query.communityId)rows=rows.filter(r=>r.communityId===query.communityId);
              if(query.buildingId&&key!=='owners')rows=rows.filter(r=>r.buildingId===query.buildingId);
              if(key==='owners'){
                if(query.houseId)rows=rows.filter(r=>db.links.some(l=>l.ownerId===r.id&&l.houseId===query.houseId));
                if(query.buildingId)rows=rows.filter(r=>db.links.some(l=>l.ownerId===r.id&&l.ownerBuildingId===query.buildingId));
                if(query.status)rows=rows.filter(r=>r.status===query.status);rows=rows.map(enriched);
              }
              if(query.q)rows=rows.filter(r=>[r.name,r.roomNo,r.phone,...(r.contactPhones||[])].some(v=>String(v||'').includes(query.q)));
              if(query.propertyNature)rows=rows.filter(r=>r.propertyNature===query.propertyNature);
              if(key==='houses')rows=rows.map(h=>({...h,owners:db.owners.filter(o=>db.links.some(l=>l.ownerId===o.id&&l.houseId===h.id))}));
              if(key==='buildings')rows=rows.map(b=>({...b,houseCount:db.houses.filter(h=>h.buildingId===b.id).length,ownerCount:new Set(db.links.filter(l=>l.ownerBuildingId===b.id||db.houses.find(h=>h.id===l.houseId)?.buildingId===b.id).map(l=>l.ownerId)).size}));
              if(key==='offices')return {offices:rows};
              return key==='houses'&&query.page?{rows:rows.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:rows.length}:rows;
            }
            let saved;
            if(action==='business-contact'){
              const owner=db.owners.find(o=>o.id===Number(id));Object.assign(owner,{name:data.name,phone:data.phone,contactPhones:data.contactPhones});owner.phoneActivity=owner.phoneActivity||[];
              for(const phone of data.confirmedPhones){let a=owner.phoneActivity.find(a=>a.phone===phone);if(!a){a={phone};owner.phoneActivity.push(a);}Object.assign(a,{last_confirmed_at:new Date().toISOString(),confirmation_source:data.source});}saved=enriched(owner);
            }else if(action==='properties'){
              if(method==='POST')db.links.push({ownerId:Number(id),...data});else db.links=db.links.filter(l=>!(l.ownerId===Number(id)&&l.houseId===query.houseId&&l.ownerBuildingId===query.ownerBuildingId));
            }else if(method==='POST'){
              const row={...data,status:'active',id:Math.max(0,...db[key].map(r=>r.id))+1};db[key].push(row);if(key==='owners')db.links.push({ownerId:row.id,houseId:data.houseId,ownerBuildingId:data.ownerBuildingId,moveInDate:data.moveInDate,billingStartDate:data.billingStartDate});
            }else if(method==='PATCH'){
              const r=db[key].find(r=>r.id===Number(id));Object.assign(r,data);
              if(key==='owners'&&(data.currentHouseId||data.currentOwnerBuildingId)){const l=db.links.find(l=>l.ownerId===r.id&&(data.currentHouseId?l.houseId===data.currentHouseId:l.ownerBuildingId===data.currentOwnerBuildingId));Object.assign(l,{houseId:data.houseId,ownerBuildingId:data.ownerBuildingId,moveInDate:data.moveInDate,billingStartDate:data.billingStartDate});}
            }
            localStorage.setItem('archive-fixture',JSON.stringify(db));return saved||{ok:true};
          }
        `};
      });
    }}],define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"'},
  });
  const server=http.createServer((req,res)=>{
    const ext=req.url==='/fixture.js'?'js':req.url==='/fixture.css'?'css':'html';res.setHeader('Content-Type',{js:'text/javascript',css:'text/css',html:'text/html; charset=utf-8'}[ext]);
    res.end(ext==='html'?'<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root" style="padding:20px"></div><script src="/fixture.js"></script>':built.outputFiles.find(f=>f.path.endsWith('.'+ext)).contents);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,page;
  try{
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    page=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
    const origin=`http://127.0.0.1:${server.address().port}`,out=path.join(app,'../../outputs/property-archive-a-implemented');fs.mkdirSync(out,{recursive:true});
    await page.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
    const row=text=>page.locator('.pa-desktop').getByRole('row').filter({hasText:text});
    const crumb=text=>page.getByRole('navigation',{name:'档案路径'}).getByRole('button',{name:text,exact:true});
    const saveButton=()=>page.locator('.ant-modal:visible .ant-modal-footer .ant-btn-primary');
    const save=()=>saveButton().click();
    const targetsReady=()=>page.waitForFunction(()=>{const button=document.querySelector('.ant-modal-footer .ant-btn-primary');return button&&!button.disabled;});
    const select=async(label,title)=>{await page.getByRole('combobox',{name:label}).locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]').click();await page.locator('.ant-select-dropdown:visible').getByTitle(title,{exact:true}).click();};
    await page.goto(origin);
    await page.locator('.pa-office header').getByRole('button',{name:'测试管理处',exact:true}).click();
    await row('枫桦景苑一期').getByRole('button',{name:'查看下级'}).click();
    await row('3号').waitFor();await page.getByText('小区地址：198弄 · 楼号不重复弄号',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'3号楼',exact:true}).count(),0);
    await page.screenshot({path:path.join(out,'buildings-desktop.png'),animations:'disabled'});
    await row('3号').getByRole('button',{name:'查看房号'}).click();
    await page.getByRole('textbox',{name:'搜索房号',exact:true}).fill('101');
    await row('101').getByRole('button',{name:/^详\s*情$/,exact:true}).click();
    await page.getByRole('dialog').getByText('两室一厅',{exact:true}).waitFor();
    await page.getByRole('dialog').getByRole('button',{name:'关 闭',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索房号',exact:true}).fill('');await row('102').getByRole('button',{name:'查看业主'}).click();await page.locator('.pa-desktop').getByText('暂无档案',{exact:true}).waitFor();await crumb('3号').click();
    await row('101').getByRole('button',{name:/^编\s*辑$/,exact:true}).click();await page.getByLabel('楼层',{exact:true}).fill('');await page.getByLabel('面积（㎡）',{exact:true}).fill('');await page.getByLabel('房型',{exact:true}).fill('');await page.getByLabel('房产备注',{exact:true}).fill('');await page.locator('.ant-modal .ant-select-clear').click();await save();await page.getByRole('dialog').waitFor({state:'hidden'});
    const cleared=await page.evaluate(()=>window.__calls.filter(c=>c.url==='/houses/1'&&c.method==='PATCH').at(-1));for(const key of ['floor','areaSqm','propertyNature','roomLayout','remark'])assert.equal(cleared.data[key],null);
    await page.reload();await row('101').getByRole('button',{name:/^详\s*情$/,exact:true}).click();assert.equal(await page.getByRole('dialog').getByText('两室一厅',{exact:true}).count(),0);await page.getByRole('dialog').getByRole('button',{name:'关 闭',exact:true}).click();
    await page.screenshot({path:path.join(out,'rooms-desktop.png'),animations:'disabled'});await page.getByRole('textbox',{name:'搜索房号',exact:true}).fill('101');
    await row('101').getByRole('button',{name:'查看业主'}).click();await row('已有业主甲').waitFor();await row('已有业主乙').waitFor();
    assert.equal(await row('已有业主甲').getByText('021-12345678',{exact:true}).isVisible(),true);
    assert.equal(await page.getByText(/记录.*联系结果|已联系成功|最后使用/).count(),0);
    await page.reload();await row('已有业主乙').waitFor();assert.match(page.url(),/level=owners/);
    await crumb('3号').click();assert.equal(await page.getByRole('textbox',{name:'搜索房号',exact:true}).inputValue(),'101');await page.goBack();await row('已有业主甲').waitFor();
    await page.goBack();await page.getByRole('textbox',{name:'搜索房号',exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'搜索房号',exact:true}).inputValue(),'101');
    await page.goForward();await row('已有业主甲').waitFor();
    await row('已有业主甲').getByText('入住：2026-11-01',{exact:false}).waitFor();
    await row('已有业主甲').locator('summary').click();await row('已有业主甲').getByText('枫桦景苑二期 · 3号 · 101',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});await page.locator('.pa-mobile').getByText('入住：2026-11-01',{exact:false}).waitFor();await page.locator('.pa-mobile').screenshot({path:path.join(out,'owners-dates-390.png'),animations:'disabled'});await page.setViewportSize({width:1920,height:1080});
    // Both independent target requests must settle, failed targets block writes and retry preserves the draft.
    await page.evaluate(()=>window.__readRules=[{url:'/buildings',communityId:1,delay:300},{url:'/houses',buildingId:1,delay:600,fail:true}]);
    await row('已有业主甲').getByRole('button',{name:/^编\s*辑$/,exact:true}).click();await page.locator('#archive_name').fill('目标列表失败草稿');assert.equal(await saveButton().isDisabled(),true);
    await page.screenshot({path:path.join(out,'target-loading.png'),animations:'disabled'});
    await page.getByRole('alert').filter({hasText:'合成目标列表失败'}).waitFor();assert.equal(await saveButton().isDisabled(),true);assert.equal(await page.locator('#archive_name').inputValue(),'目标列表失败草稿');
    const beforeTargetRetry=await page.evaluate(()=>window.__calls.filter(c=>c.method!=='GET').length);await page.screenshot({path:path.join(out,'target-error-retains-input.png'),animations:'disabled'});
    await page.getByRole('button',{name:'重试目标列表',exact:true}).click();await targetsReady();assert.equal(await page.locator('#archive_name').inputValue(),'目标列表失败草稿');assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.method!=='GET').length),beforeTargetRetry);
    // An empty target list is not an implicit unlink. Out-of-order community results cannot replace the current list.
    await page.evaluate(()=>window.__readRules=[{url:'/buildings',communityId:2,rows:[]}]);await select('当前关联 · 小区','枫桦景苑二期');await targetsReady();await save();assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.method!=='GET').length),beforeTargetRetry);
    await page.evaluate(()=>window.__readRules=[{id:'stale-community',url:'/buildings',communityId:1,delay:700},{url:'/buildings',communityId:2,delay:50}]);await select('当前关联 · 小区','枫桦景苑一期');await select('当前关联 · 小区','枫桦景苑二期');await targetsReady();await select('当前关联 · 楼栋 / 商铺','3号');await targetsReady();await select('当前关联 · 房号','101');await page.waitForFunction(()=>window.__settledReadRules.includes('stale-community'));await page.getByRole('combobox',{name:'当前关联 · 房号'}).locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]').click();assert.equal(await page.locator('.ant-select-dropdown:visible').getByTitle('102',{exact:true}).count(),0);await page.keyboard.press('Escape');
    await select('当前关联 · 小区','枫桦景苑一期');await targetsReady();await select('当前关联 · 楼栋 / 商铺','3号');await targetsReady();await select('当前关联 · 房号','101');
    await page.getByRole('button',{name:/^取\s*消$/,exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    await row('已有业主甲').getByRole('button',{name:/^编\s*辑$/,exact:true}).click();await targetsReady();
    await page.locator('#archive_name').fill('已有业主甲更新');
    await page.getByLabel('当前房产 · 入住日期',{exact:true}).fill('2026-11-02');
    await page.getByLabel('当前房产 · 起费日期',{exact:true}).fill('2026-11-12');
    await select('当前关联 · 房号','102');
    await page.evaluate(()=>window.__failWrite=true);await save();await page.getByRole('alert').filter({hasText:'合成保存失败'}).waitFor();
    assert.equal(await page.locator('#archive_name').inputValue(),'已有业主甲更新');
    await page.screenshot({path:path.join(out,'save-error-retains-input.png'),animations:'disabled'});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.equal(await page.getByRole('dialog').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);await page.getByRole('dialog').evaluate(e=>{e.closest('.ant-modal-wrap').scrollTop=0;});await page.screenshot({path:path.join(out,'owner-editor-390.png'),animations:'disabled'});await page.getByRole('alert').filter({hasText:'合成保存失败'}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'owner-editor-error-390.png'),animations:'disabled'});await page.setViewportSize({width:1920,height:1080});await save();
    await page.getByRole('dialog').waitFor({state:'hidden'});await row('已有业主乙').waitFor();
    const edit=await page.evaluate(()=>window.__calls.filter(c=>c.url==='/owners-mgmt/1'&&c.method==='PATCH').at(-1));assert.equal(edit.data.currentHouseId,1);assert.equal(edit.data.houseId,2);assert.equal(edit.data.moveInDate,'2026-11-02');assert.equal(edit.data.billingStartDate,'2026-11-12');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('archive-fixture')).links.some(l=>l.ownerId===1&&l.houseId===3)),true);
    await page.getByRole('button',{name:'新增业主',exact:true}).click();await save();await page.locator('#archive_name[aria-invalid="true"]').waitFor();assert.equal(await page.evaluate(()=>document.activeElement.id),'archive_name');
    await page.locator('#archive_name').fill('测试业主丙');await page.getByLabel('主要联系电话',{exact:true}).fill('13800000003');await page.getByRole('button',{name:'添加联系电话',exact:true}).click();await page.getByLabel('其他电话 1',{exact:true}).fill('021-88886666');await save();await row('测试业主丙').waitFor();
    await page.screenshot({path:path.join(out,'owners-desktop.png'),animations:'disabled'});
    for(const width of [390,768]){await page.setViewportSize({width,height:844});await page.locator('.pa-mobile').getByText('测试业主丙',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.locator('.pa-mobile').screenshot({path:path.join(out,`owners-${width}.png`),animations:'disabled'});}
    await page.setViewportSize({width:1440,height:1000});await crumb('3号').click();await page.getByRole('textbox',{name:'搜索房号',exact:true}).fill('');await row('102').getByRole('button',{name:'查看业主'}).click();await row('已有业主甲更新').waitFor();await row('已有业主甲更新').getByText('2026-11-02',{exact:false}).waitFor();
    await crumb('枫桦景苑一期').click();await row('沿街商铺').getByRole('button',{name:'查看业主'}).click();await page.getByRole('heading',{name:'沿街商铺 · 绑定业主'}).waitFor();
    await page.locator('.pa-chips').getByRole('button',{name:'枫桦景苑二期',exact:true}).click();await page.getByText('小区地址：228弄 · 楼号不重复弄号',{exact:true}).waitFor();
    await page.evaluate(()=>{window.__failRead=true;});await page.getByRole('button',{name:/^刷\s*新$/,exact:true}).click();await page.getByRole('alert').filter({hasText:'合成读取失败'}).waitFor();await page.getByRole('button',{name:/^重\s*试$/,exact:true}).click();await row('3号').waitFor();
    await page.goto(origin+'/?level=owners&community=2&building=2&house=1');await page.getByText('当前房产不可用或无查看权限，请从上级重新选择。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__calls.some(c=>c.url==='/owners-mgmt')),false);
    await page.goto(origin+'/?level=owners&office=1&community=1&building=1&house=1');await row('已有业主乙').waitFor();await page.evaluate(()=>{window.__session={user:{id:2},actingOffice:{id:2},access:{isTenantAdmin:true}};window.dispatchEvent(new Event('fixture-scope'));});await row('测试管理处').waitFor();assert.equal(new URL(page.url()).search,'');assert.equal(await page.getByRole('heading',{name:/101 · 绑定业主/}).count(),0);
    await page.goto(origin+'/?readonly=1');await row('测试管理处').waitFor();assert.equal(await page.getByRole('button',{name:/新建|新增|编辑|删除/}).count(),0);await page.screenshot({path:path.join(out,'readonly.png'),animations:'disabled'});
    // Shared business-contact component: no confirmation on open, explicit per-number payload, errors retain draft/selection.
    await page.goto(origin+'/contacts');await page.getByRole('button',{name:/业务联系人/}).click();await page.getByLabel('主要联系电话',{exact:true}).waitFor();
    assert.equal((await page.evaluate(()=>window.__calls.filter(c=>c.method!=='GET'))).length,0);
    await page.getByLabel('业主姓名',{exact:true}).fill('乙业务更新');await page.getByRole('button',{name:'添加联系电话',exact:true}).click();await page.getByLabel('其他联系电话 1',{exact:true}).fill('021-66667777');
    await page.getByLabel('本次已核实 021-66667777',{exact:true}).check();await page.evaluate(()=>window.__failWrite=true);await page.getByRole('button',{name:'保存联系人与本次确认',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成保存失败'}).waitFor();
    assert.equal(await page.getByLabel('业主姓名',{exact:true}).inputValue(),'乙业务更新');assert.equal(await page.getByLabel('本次已核实 021-66667777',{exact:true}).isChecked(),true);
    await page.getByRole('button',{name:'保存联系人与本次确认',exact:true}).click();await page.getByRole('status').filter({hasText:'联系人已保存'}).waitFor();
    const contact=await page.evaluate(()=>window.__calls.filter(c=>c.url.includes('/business-contact')&&c.method==='PATCH').at(-1));assert.deepEqual(contact.data.confirmedPhones,['021-66667777']);assert.equal(contact.data.source,'cashier');
    await page.reload();await page.getByRole('button',{name:/业务联系人/}).click();await page.getByText(/上次确认：.*收银业务/).waitFor();assert.equal(await page.getByLabel('本次已核实 021-66667777',{exact:true}).isChecked(),false);
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:path.join(out,'business-contact-mobile.png'),animations:'disabled'});
    await page.goto(origin+'/contacts?readonly=1');await page.getByRole('button',{name:/业务联系人/}).click();await page.getByLabel('业主姓名',{exact:true}).waitFor();assert.equal(await page.getByLabel('业主姓名',{exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'保存联系人与本次确认',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
  }catch(error){if(page){const out=path.join(app,'../../outputs/property-archive-a-implemented');await page.screenshot({path:path.join(out,'browser-failure.png'),animations:'disabled'});fs.writeFileSync(path.join(out,'browser-failure.html'),(await page.content()).replace(/></g,'>\n<'));fs.writeFileSync(path.join(out,'browser-failure-selects.json'),JSON.stringify(await page.getByRole('combobox').evaluateAll(elements=>elements.map(e=>({id:e.id,labels:[...(e.labels||[])].map(l=>l.textContent),ariaLabel:e.getAttribute('aria-label'),labelledby:e.getAttribute('aria-labelledby')}))),null,2));}throw error;}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
