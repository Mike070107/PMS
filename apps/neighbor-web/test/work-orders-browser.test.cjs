const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const { chromium } = require('playwright-core');
const app = path.resolve(__dirname, '..');
const esbuild = createRequire(require.resolve('vite'))('esbuild');
const evidence = path.resolve(app, '../../outputs/work-order-completion-overlay-20261117', process.env.PMS_UI_EVIDENCE_PHASE || 'final');

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
if(mode==='waiting-material') orders.find(o=>o.id===4).status='waiting_material';
export const address = {tree:async()=>[]};
export const repairs = {
 list:async(q)=>{window.__calls.push(q); if(mode==='loading') return new Promise(()=>{}); if(mode==='error') throw Error('合成接口错误：请稍后重试'); return q.status ? [] : q.scope==='done' ? orders.filter(o=>o.status==='completed') : orders;},
 detail:async(id)=>{await new Promise(r=>setTimeout(r,500)); if(mode==='detail-error') throw Error('合成详情错误'); const workOrder=orders.find(o=>o.id===id); return {workOrder,request:{id:1,content,attachments:[]},materialUsages:[],logs:Array.from({length:40},(_,i)=>({id:i,action:'progress',createdAt:'2026-11-08T00:00Z',toStatus:'in_progress',note:'合成进度记录 '+i}))};},
 stockOptions:async()=>{if(mode==='stock-error') throw Error('合成库存读取失败'); return {warehouseId:1,warehouseName:'合成维修仓',warehouses:Array.from({length:12},(_,i)=>({id:i+1,name:'合成仓库 '+(i+1),own:i===0,hasStock:i<2})),items:Array.from({length:8},(_,i)=>({materialId:i+1,name:'合成维修材料 '+(i+1),qty:5,unit:'个'}))};},
 complete:async(id,payload)=>{window.__calls.push({action:'complete',id,payload}); if(mode==='completion-error'&&window.__calls.filter(c=>c.action==='complete').length===1) throw Error('合成完工错误：请重试'); if(mode==='completion-wait') await new Promise(r=>{window.__completeResolve=r;}); Object.assign(orders.find(o=>o.id===id),{status:'done_pending_review',completedAt:'2026-11-17T09:00Z',...payload}); return {};},
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
    define:{'process.env.NODE_ENV':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""','import.meta.env.VITE_API_BASE_URL':'"/api/v1"'},
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

test('更多菜单：桌面/窄屏点外部收起，按钮可切换，菜单选项仍进入确认而不直接执行', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  for (const width of [1440,375]) {
   await page.setViewportSize({width,height:width===375?812:1000});
   await page.goto(url+'/?view=list&filter=all');
   await page.locator('.wo-list-table tbody tr').filter({hasText:'SYN-1'}).locator('td').nth(1).click();
   await page.locator('.next').waitFor();
   const trigger=page.getByRole('button',{name:'更多 ▾',exact:true});
   const menu=page.locator('.more .menu');
   await trigger.click();
   await menu.waitFor();
   await shot(page,`more-${width}-open`);
   // 标题/空白区域点击不能被Sheet内部的事件拦截吞掉。
   await page.locator('.next .t').click();
   await menu.waitFor({state:'detached',timeout:1500});
   assert.equal(await page.locator('.sheet').count(),1,'仅收起更多，工单详情仍打开');
   assert.equal(await page.locator('.flow').count(),0,'点空白不得触发危险操作');
   await shot(page,`more-${width}-outside-closed`);
   await page.locator('.tabs button').getByText('处理进度',{exact:true}).click();
   await trigger.click();
   await menu.waitFor();
   // 窄屏弹层会盖住右侧页签，点击仍露在外面的概况，不强制穿透菜单。
   await page.locator('.tabs button').getByText('概况',{exact:true}).click();
   await menu.waitFor({state:'detached',timeout:1500});
   assert.equal(await page.locator('.tabs button.on').textContent(),'概况','外部控件原有点击仍生效');
   await trigger.click(); await menu.waitFor();
   await trigger.click(); await menu.waitFor({state:'detached'});
   for (const [label,confirm] of [['撤单','确认撤单'],['作废','确认作废']]) {
    await trigger.click(); await menu.waitFor();
    await menu.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('button',{name:confirm,exact:true}).waitFor();
    assert.equal(await menu.count(),0,'点击菜单内选项正常进入流程并收起菜单');
    await page.locator('.flow').getByRole('button',{name:'取消',exact:true}).click();
    await page.locator('.next').waitFor();
   }
  }
 });
});

async function openFinishOrder(page,url,mode='') {
 await page.goto(url+'/?view=list&filter=all'+(mode?'&mode='+mode:''));
 await page.locator('.wo-list-table tbody tr').filter({hasText:'SYN-4'}).locator('td').nth(1).click();
 await finishTrigger(page).waitFor();
}
const finishTrigger=page=>page.getByRole('button',{name:/^(登记完工 · 用料扣料|材料已到 · 登记完工)$/});
const panel=page=>page.locator('.flow:visible').filter({has:page.getByRole('heading',{name:'登记完工 · 用料扣料'})});

test('真实浏览器：完工面板在按钮下方覆盖Tab区域，桌面/窄屏/横屏可独立滚动', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  for(const [width,height,mode] of [[1440,1000,''],[375,812,''],[812,375,''],[375,812,'waiting-material']]){
   await page.setViewportSize({width,height});
   await openFinishOrder(page,url,mode);
   await finishTrigger(page).click();
   await panel(page).waitFor();
   await shot(page,`finish-position-${width}${mode?'-'+mode:''}`);
   const p=await panel(page).boundingBox();
   const tabs=await page.locator('.wo-sheet-head .tabs').boundingBox();
   assert.ok(p.y<tabs.y+tabs.height,`${width}: 面板应从顶部动作下方覆盖页签，不在页签下面另起正文`);
   const trigger=await finishTrigger(page).boundingBox();
   assert.ok(p.y>=trigger.y+trigger.height-1,`${width}: 浮层不能盖住登记完工按钮`);
   assert.ok(p.y<=trigger.y+trigger.height+8,`${width}: 应紧接实际按钮下方，手机操作换行不能产生大间隔`);
   assert.equal(await finishTrigger(page).getAttribute('aria-expanded'),'true');
   assert.ok(p.x>=0&&p.x+p.width<=width+1,`${width}: 不应横向出界`);
   const overlay=page.locator('.wo-completion-overlay');
   const bounds=await overlay.boundingBox();
   assert.ok(bounds.y+bounds.height<=height+1,`${width}: 面板必须限制在视口内`);
   assert.ok(await overlay.evaluate(el=>el.scrollHeight>el.clientHeight),`${width}: 长表单在面板内部滚动`);
   await panel(page).getByRole('button',{name:'提交完工 · 通知业主验收',exact:true}).scrollIntoViewIfNeeded();
   assert.ok(await panel(page).getByRole('button',{name:'提交完工 · 通知业主验收',exact:true}).isVisible());
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('.sheet').count(),1,'Esc仅收起完工面板，不关详情');
   assert.equal(await page.locator('.flow:visible').count(),0);
   assert.ok(await finishTrigger(page).evaluate(el=>el===document.activeElement),'收起后恢复顶部触发按钮焦点');
  }
 });
});

test('真实浏览器：切Tab/外点及时回收完工面板，重开保留草稿且不提交业务', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  for(const width of [1440,375]){
   await page.setViewportSize({width,height:width===375?812:1000});
   await openFinishOrder(page,url);
   for(const name of ['处理进度','用料与收费','养护单','概况']){
    await finishTrigger(page).click();
    await panel(page).locator('textarea').fill('合成草稿：已更换接头，未提交');
    // 面板按要求覆盖页签，使用真实键盘激活被覆盖的页签，不用强制指针点击。
    const targetTab=page.locator('.wo-sheet-head .tabs button').getByText(name,{exact:true});
    await targetTab.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.flow:visible').count(),0,`切换${name}必须同步收起，不挡住新Tab`);
    assert.equal(await page.locator('.tabs button.on').textContent(),name);
    await finishTrigger(page).click();
    assert.equal(await panel(page).locator('textarea').inputValue(),'合成草稿：已更换接头，未提交');
    await panel(page).getByRole('button',{name:'取消',exact:true}).click();
   }
   await finishTrigger(page).click();
   await finishTrigger(page).click();
   assert.equal(await page.locator('.flow:visible').count(),0,'再次点击触发按钮折叠');
   await finishTrigger(page).click();
   await page.locator('.sh-h h2').click();
   assert.equal(await page.locator('.flow:visible').count(),0,'详情内外点可收起');
   assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.action==='complete').length),0);
   await finishTrigger(page).click();
   await page.locator('.sh-h button.x').click();
   assert.equal(await page.locator('.sheet').count(),0,'关闭工单同时清理浮层');
   await page.locator('.wo-list-table tbody tr').filter({hasText:'SYN-4'}).locator('td').nth(1).click();
   await finishTrigger(page).click();
   assert.equal(await panel(page).locator('textarea').inputValue(),'','关闭详情后不串留上一张面板草稿');
  }
 });
});

test('真实浏览器：完工失败保留输入及幂等键，等待期间切Tab不重发，成功收起并回读', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  await openFinishOrder(page,url,'completion-error');
  await finishTrigger(page).click();
  await panel(page).locator('textarea').fill('合成维修结果，禁止生产写入');
  await panel(page).getByPlaceholder('例如：卫生间地漏').fill('合成卫生间');
  await panel(page).getByPlaceholder('已带出报修描述，可改').fill('合成接头漏水');
  await panel(page).locator('.matpick-item').first().click();
  await panel(page).locator('.mp-row input[inputmode="decimal"]').fill('2');
  await panel(page).locator('input[type="number"]').fill('12.5');
  await panel(page).locator('.field').filter({hasText:'维修备注'}).locator('input').fill('合成备注');
  await panel(page).getByRole('button',{name:'提交完工 · 通知业主验收',exact:true}).click();
  const error=page.getByRole('alert').filter({hasText:'合成完工错误：请重试'});
  await error.waitFor();
  await error.evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));
  const errorBounds=await error.boundingBox(), overlayBounds=await page.locator('.wo-completion-overlay').boundingBox();
  assert.ok(errorBounds.y>=overlayBounds.y && errorBounds.y+errorBounds.height<=overlayBounds.y+overlayBounds.height,'失败提示应自动滚入面板可见区');
  assert.equal(await panel(page).locator('textarea').inputValue(),'合成维修结果，禁止生产写入');
  await shot(page,'finish-submit-error');
  await page.keyboard.press('Escape');
  await finishTrigger(page).click();
  assert.equal(await panel(page).locator('textarea').inputValue(),'合成维修结果，禁止生产写入');
  await panel(page).getByRole('button',{name:'提交完工 · 通知业主验收',exact:true}).click();
  await page.getByRole('button',{name:'代业主验收',exact:true}).waitFor();
  assert.equal(await page.locator('.flow:visible').count(),0);
  const calls=await page.evaluate(()=>window.__calls.filter(c=>c.action==='complete'));
  assert.equal(calls.length,2); assert.deepEqual(calls[0].payload,calls[1].payload,'位置/现象/内容/用料/费用/备注及幂等键均须保留');
  assert.equal(calls[1].payload.faultLocation,'合成卫生间');
  assert.equal(calls[1].payload.faultSymptom,'合成接头漏水');
  assert.equal(calls[1].payload.feeCents,1250);
  assert.equal(calls[1].payload.materials[0].qty,2);
  assert.equal(calls[1].payload.actionNote,'合成备注');
  await shot(page,'finish-submit-success');
  await openFinishOrder(page,url,'completion-wait');
  await finishTrigger(page).click();
  await panel(page).locator('textarea').fill('合成等待结果');
  await panel(page).getByRole('button',{name:'提交完工 · 通知业主验收',exact:true}).click();
  assert.ok(await panel(page).getByRole('button',{name:'提交中…',exact:true}).isDisabled());
  await shot(page,'finish-submit-wait');
  await page.locator('.tabs button').getByText('处理进度',{exact:true}).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.flow:visible').count(),0);
  await finishTrigger(page).click();
  assert.ok(await panel(page).getByRole('button',{name:'提交中…',exact:true}).isDisabled());
  assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.action==='complete').length),1);
  await page.evaluate(()=>window.__completeResolve());
  await page.getByRole('button',{name:'代业主验收',exact:true}).waitFor();
  assert.equal(await page.locator('.flow:visible').count(),0);
  await openFinishOrder(page,url,'stock-error');
  await finishTrigger(page).click();
  await page.getByText('合成库存读取失败',{exact:true}).waitFor();
  await shot(page,'finish-stock-error');
 });
});

test('真实浏览器：展开中响应式重定位，旧工单迟到完成不关闭或覆盖新工单', {timeout:90000},async()=>{
 await fixture(async(page,url)=>{
  await openFinishOrder(page,url,'completion-wait');
  await finishTrigger(page).click();
  await panel(page).locator('textarea').fill('旧工单合成结果');
  for(const [width,height] of [[375,812],[1440,1000]]){
   await page.setViewportSize({width,height});
   await page.waitForFunction(()=>{
    const b=document.querySelector('[data-flow="finish"]').getBoundingClientRect();
    const p=document.querySelector('.wo-completion-overlay').getBoundingClientRect();
    return Math.abs(p.top-b.bottom-4)<1&&p.right<=innerWidth;
   });
   assert.equal(await panel(page).locator('textarea').inputValue(),'旧工单合成结果');
  }
  await panel(page).getByRole('button',{name:'提交完工 · 通知业主验收',exact:true}).click();
  await page.locator('.sh-h button.x').click();
  await page.locator('.wo-list-table tbody tr').filter({hasText:'SYN-3'}).locator('td').nth(1).click();
  await finishTrigger(page).click();
  await panel(page).locator('textarea').fill('新工单独立草稿');
  const lists=await page.evaluate(()=>window.__calls.filter(c=>!c.action).length);
  await page.evaluate(()=>window.__completeResolve());
  await page.waitForFunction(n=>window.__calls.filter(c=>!c.action).length>n,lists);
  assert.ok((await page.locator('.sh-h .l1').textContent()).includes('SYN-3'));
  assert.equal(await panel(page).locator('textarea').inputValue(),'新工单独立草稿','旧请求返回不能关闭/覆盖当前新工单');
  await shot(page,'finish-stale-response-isolated');
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
