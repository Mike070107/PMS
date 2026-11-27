const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');const{chromium}=require('playwright-core'),esbuild=require('node:module').createRequire(require.resolve('vite'))('esbuild');const app=path.resolve(__dirname,'..'),out=path.resolve(app,'../../outputs/cashier-plate-search-20261117');
test('actual ParkingTab rejects a stale plate after switching households in Chrome',{timeout:60000},async()=>{
const api=`export const address={tree:async()=>[]};export const uploadBlobTo=async()=>{throw Error('Unexpected upload in read-only ownership test')};window.calls=[];const row=(plate,owner,id)=>({database:'parking1',fields:{PmsMeta__PlateHistory:JSON.stringify([{before:'沪T00001',after:plate,at:'2026-11-20T13:19:02Z',operatorName:'PMS'}]),P_id:id,P_plate:plate,Owner__owner_Name:"合成住户",Owner__owner_Add:owner,P_Effective:'0000100',End_Time:'2027-12-31 00:00:00'}});export const accessCardIssuance={deliyunVehiclesByPlate:async()=>({rows:[]}),parkingHistory:async({plate,sourceRecordId,database})=>{const base={eventType:'plate_change',database,sourceRecordId,plateBefore:'沪T00001',plateAfter:plate,summary:'合成换牌记录',changes:[],operator:'测试员工',timeBasis:'operation'};return{vehicleHistory:[{...base,id:1,source:'pms',occurredAt:'2026-11-20T13:19:01Z'},{...base,id:2,source:'parking_gateway',occurredAt:'2026-11-20T13:19:03Z'},{...base,id:3,source:'pms',occurredAt:'2026-11-19T13:19:01Z'}],userHistory:[]}},createParkingQuery:async term=>{window.calls.push(term);return{id:1,status:'completed',rows:term==='228/31/302'?[row('沪A216P4','228/31/302',90)]:[row('沪M03212','198/03/301',3934)]}}};export const request=async o=>{if(o.method&&o.method!=='GET')throw Error('Unexpected business write');if(o.url==='/business/household-parking')return{boundPlates:o.query.houseId===729?['沪M03212']:[],room:o.query.houseId===15?'198/3/301':'228/31/302',targets:[],localDatabases:['parking1'],deliyun:[]};if(o.url==='/vehicle-intakes'||o.url==='/business/plate-tags')return[];throw Error('Unexpected request '+o.url)};`;
const entry=`import React,{useState,useCallback}from'react';import{createRoot}from'react-dom/client';import ParkingTab from '@/components/cashier/ParkingTab';import '@/styles/design.css';import '@/styles/app.css';const houses=[{id:15,communityId:1,lane:'198',buildingNo:'3',roomNo:'301'},{id:1074,communityId:1,lane:'228',buildingNo:'31',roomNo:'302'},{id:729,communityId:1,buildingNo:'729',roomNo:'商铺'}];function Fixture(){const[n,N]=useState(0),[cart,C]=useState([]);const onCart=useCallback((items)=>C(items),[]);return <main><button onClick={()=>N(1)}>切换到228弄31号302室</button><button onClick={()=>N(2)}>查询729商铺</button><output id="cart">{JSON.stringify(cart)}</output><ParkingTab key={houses[n].id} house={houses[n]} rules={[]} initialPlate={n===2?null:"沪M03212"} onCart={onCart}/></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
const built=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:app},bundle:true,write:false,format:'iife',jsx:'automatic',outfile:'fixture.js',alias:{'@/lib/perm':path.join(app,'test/parking-browser-permission.ts'),'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"test"','import.meta.env.BASE_URL':'"/"'},plugins:[{name:'readonly-api',setup(b){b.onResolve({filter:/^@pms\/api-client$/},()=>({path:'api',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:api,loader:'js'}));}}]});
const resources=new Map(built.outputFiles.map(f=>['/'+path.basename(f.path),f.contents]));resources.set('/',Buffer.from('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(resources.get(req.url)||'')});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{fs.mkdirSync(out,{recursive:true});browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});for(const width of[1440,375]){const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('tbody tr').filter({hasText:'沪M03212'}).waitFor();const box=page.locator('tbody tr').filter({hasText:'沪M03212'}).getByRole('checkbox');
assert.equal(await box.isChecked(),false);
await box.check();
await box.uncheck();
assert.equal(await box.isChecked(),false);
await box.check();
const heading=page.locator('.cashier-vehicle-actions summary');
assert.equal(await heading.innerText(),'车辆管理 · 沪M03212');
assert.equal(await page.getByRole('button',{name:'变更车牌',exact:true}).count(),0);
await heading.focus(); await heading.press('Enter');
await page.getByRole('button',{name:'变更车牌',exact:true}).waitFor();
await heading.press('Space');
await page.getByRole('button',{name:'变更车牌',exact:true}).waitFor({state:'hidden'});
await heading.click();
for (const name of ['修改车辆类型','变更车牌','变更绑定用户','调整车库授权','变更历史','更新住户资料']) {
 await page.getByRole('button',{name,exact:true}).click();
 if(name==='变更历史'){
   const events=page.locator('.veh-history-event');await events.first().waitFor();
   assert.equal(await events.count(),2);
   const latest=events.first();assert.match(await latest.innerText(),/原车牌/);
   assert.equal(await latest.locator('details').getAttribute('open'),null);
   await latest.getByText('查看来源记录（3）').click();
   assert.equal(await latest.locator('.veh-history-source:visible').count(),3);
 }
 await page.getByRole('button',{name:/关闭/}).last().click();
}
await page.getByRole('button',{name:'切换到228弄31号302室'}).click();await page.locator('tbody tr').filter({hasText:'沪A216P4'}).waitFor();assert.equal(await page.locator('tbody tr').filter({hasText:'沪M03212'}).count(),0);assert.equal(await page.locator('#cart').textContent(),'[]');assert.ok((await page.evaluate(()=>window.calls)).includes('228/31/302'));assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'household-isolation-'+width+'.png'),fullPage:true});await page.getByRole('button',{name:'查询729商铺'}).click();
const shopRow=page.locator('tbody tr').filter({hasText:'沪M03212'});
await shopRow.getByText('2027-12-31').waitFor();
assert.equal(await shopRow.getByRole('checkbox').isEnabled(),true);
assert.equal(await shopRow.getByRole('checkbox').isChecked(),false);
assert.equal((await page.evaluate(()=>window.calls)).includes('729/商铺'),false);
await page.close();}}
finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
