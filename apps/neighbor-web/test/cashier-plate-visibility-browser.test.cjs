const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core'),esbuild=require('node:module').createRequire(require.resolve('vite'))('esbuild');
const app=path.resolve(__dirname,'..'),out=path.resolve(app,'../../outputs/cashier-plate-search-20261117');
test('tail search vehicle is visible and clickable without scrolling page below address menu',{timeout:60000},async()=>{
 fs.mkdirSync(out,{recursive:true});
 const source=fs.readFileSync(path.join(app,'src/pages/Cashier.tsx'),'utf8');const searchCode=source.slice(source.indexOf('  const normSearch ='),source.indexOf('\n  const loadBills'));
 const pickCode=source.slice(source.indexOf('  const onUniPick ='),source.indexOf('  const selectedVehicle ='));
 const entry=`import React,{useState,useCallback}from'react';import{createRoot}from'react-dom/client';import UniSearch from '@/components/cashier/UniSearch';import '@/styles/design.css';import '@/styles/app.css';import '@/styles/erp-reference.css';
 const house={id:15,communityId:1,communityName:'合成小区一期',buildingNo:'3',lane:'198',roomNo:'301',owner:null};const request=async({query})=>({registrationMatches:['1234','13900001234'].includes(query.q)&&query.serviceType==='parking_monthly'?[{id:66,houseId:902,plateNo:'沪A1C678',contactPhone:'13900001234',openIntakeId:66}]:[],houses:query.q==='1234'?[{...house,id:7,owner:{phone:'13800001234'}}]:query.q==='198/3/301'?[house]:query.q==='2199'?[{...house,id:7,roomNo:'999',owner:{phone:'13821991380'}},{...house,id:21,lane:'2199',buildingNo:'10',roomNo:'301'}]:[],vehicles:query.q==='2199'?[{id:8,houseId:7,plateNo:'沪B12345'}]:[],accessCards:[]});const accessCardIssuance={createParkingQuery:async term=>{if(term==='1234')throw Error('现场离线');if(term==='C678')return {status:'completed',rows:[{fields:{P_plate:'沪A1C678'},pmsMatch:{houseId:902}}]};if(!['03212','2199'].includes(term))throw Error('wrong suffix');return {id:1,status:'completed',rows:[{database:'parking1',fields:{P_plate:term==='2199'?'沪A02199':'沪A03212',Owner__owner_Name:'198/03/301'}}]}}};
 const communities=[{id:1,name:'枫桦景苑二期',buildings:[{lane:null,buildingNo:'53',houses:[{id:902,roomNo:'902'}]}]}];function Fixture(){const[pick,P]=useState('');const setErr=()=>{},setPicked=()=>{},setTab=()=>{},applyHouse=()=>{},setParkPlate=P;
 const navigate=path=>{history.pushState({},'',path);P('登记单')};${searchCode}${pickCode}return <main style={{paddingTop:280,paddingInline:16}}><UniSearch communities={[]} search={searchByQ} onPick={onUniPick}/><output id="pick">{pick}</output></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
 const built=await esbuild.build({stdin:{contents:entry,loader:'tsx',resolveDir:app},bundle:true,write:false,format:'iife',jsx:'automatic',outfile:'fixture.js',alias:{'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"test"'}});
 const resources=new Map(built.outputFiles.map(f=>['/'+path.basename(f.path),f.contents]));resources.set('/',Buffer.from('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'));
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(resources.get(req.url)||'');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});for(const width of [1440,375]){const page=await browser.newPage({viewport:{width,height:812}});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('input').fill('03212');const vehicle=page.getByRole('button',{name:/沪A03212/});await vehicle.waitFor();await page.screenshot({path:path.join(out,`vehicle-${width}-${process.env.PMS_UI_EVIDENCE_PHASE||'after'}.png`)});const r=await vehicle.boundingBox();assert.ok(r.y>=0&&r.y+r.height<=812,`vehicle must be in viewport: ${JSON.stringify(r)}`);await page.mouse.click(r.x+r.width/2,r.y+r.height/2);assert.equal(await page.locator('#pick').textContent(),'沪A03212');await page.locator('input').fill('2199');
const hit=page.getByRole('button',{name:/沪A02199/});await hit.waitFor();
assert.equal(await hit.locator('mark').innerText(),'2199');
assert.match(await hit.innerText(),/沪A02199[\s\S]+301/);
const phone=page.getByRole('button',{name:/13821991380/}); await phone.waitFor();
assert.equal(await phone.locator('mark').innerText(),'2199');
const addressOnly=page.getByRole('button',{name:/2199弄10号301/});
assert.equal(await addressOnly.locator('mark').innerText(),'2199');
assert.equal(await addressOnly.locator('.address-search-detail').innerText(),'2199弄');
assert.deepEqual(await page.locator('.as-sugg .as-group').allTextContents(),['车牌','PMS 业主电话','地址']);
for(const row of [hit,phone,addressOnly]){
 const left=await row.locator('.address-search-detail').boundingBox();
 const right=await row.locator('.address-search-location').boundingBox();
 assert.ok(left.x+left.width<=right.x+1);
}
await page.locator('input').press('Enter');
await addressOnly.waitFor();


assert.equal(await page.getByText('沪B12345',{exact:true}).count(),0);
assert.equal(await page.locator('.ant-cascader-menus:visible').count(),0);
await hit.click();
await page.waitForFunction(()=>document.querySelector('#pick').textContent==='沪A02199');
await page.locator('input').fill('198/3/301');
const address=page.getByRole('button').filter({has:page.locator('mark')});
await address.waitFor();
assert.deepEqual(await address.locator('mark').allTextContents(),['198','3','301']);
const selection=await address.locator('mark').first().evaluate(el=>{
  const style=getComputedStyle(el);return [style.backgroundColor,style.color,style.fontWeight];
});
assert.deepEqual(selection,['rgb(20, 108, 67)','rgb(255, 255, 255)','800']);

await page.locator('input').fill('C678');
const vehicle902=page.getByRole('button',{name:/沪A1C678/});
assert.match(await vehicle902.innerText(),/枫桦景苑二期.*53.*902/s);
await vehicle902.click();
await page.waitForFunction(()=>document.querySelector('#pick').textContent==='沪A1C678');
for(const term of ['13900001234','1234']){
 await page.locator('input').fill(term);
 const row=page.getByRole('button',{name:/沪A1C678.*本车联系手机/s});
 await row.waitFor();
 assert.match(await row.innerText(),/53.*902.*本车联系手机.*13900001234/s);
 if(term==='1234'){
  await page.getByText('PMS 业主电话',{exact:true}).waitFor();
  await page.getByRole('button',{name:/13800001234/}).waitFor();
 }
 await row.click();
 assert.equal(await page.locator('#pick').textContent(),'登记单');
 assert.equal(new URL(page.url()).pathname+new URL(page.url()).search,'/cashier?intakeId=66');
}
await page.close();}}
 finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
