const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const http=require('node:http');
const fs=require('node:fs');
const {createRequire}=require('node:module');
const {chromium}=require('playwright-core');
const app=path.resolve(__dirname,'..');
const esbuild=createRequire(require.resolve('vite'))('esbuild');
// Production entry components and shared contact component; deterministic API/auth adapters only.
// This verifies entry wiring and interactions, not a running API, real auth, persistence or payments.
test('正式收银/公寓/新车登记/已存车牌/续费入口可逐号确认，加载不写且不触发收费/设备动作',async()=>{
 const built=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import {App,ConfigProvider} from 'antd';import Cashier from '@/pages/Cashier';import ApartmentCashier from '@/pages/ApartmentCashier';import Vehicles from '@/pages/Vehicles';import RenewSheet from '@/components/vehicle-ops/RenewSheet';import {fixtureRow} from '@pms/api-client';import '@/styles/design.css';import '@/styles/app.css';
 const route=location.pathname;createRoot(document.getElementById('root')).render(<BrowserRouter><ConfigProvider><App>{route==='/cashier'?<Cashier/>:route==='/apartment'?<ApartmentCashier/>:route==='/vehicles'?<Vehicles/>:<RenewSheet plate="沪A00001" rows={[fixtureRow]} cloud={null} onClose={()=>{}} onDone={()=>{}}/>}</App></ConfigProvider></BrowserRouter>);`,loader:'tsx',resolveDir:app},bundle:true,write:false,outfile:'entry.js',format:'iife',jsx:'automatic',alias:{'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""'},plugins:[{name:'entry-fixtures',setup(b){b.onResolve({filter:/^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm)$/},a=>({path:a.path,namespace:'entry-fixture'}));b.onLoad({filter:/.*/,namespace:'entry-fixture'},a=>{
 if(a.path.endsWith('/perm'))return {contents:`export const can=()=>true;`,loader:'js'};
 if(a.path.endsWith('/auth'))return {contents:`const session={user:{id:1,name:'测试收费员'},access:{isTenantAdmin:true,scopeAll:true,communityIds:[1]}};export const useSession=()=>session;`,loader:'js'};
 return {loader:'js',contents:`
 const owner={id:1,name:'入口测试业主',phone:'13800000001',contactPhones:['13800000001','021-12345678']};
 const house={id:1,buildingId:1,communityId:1,communityName:'测试小区',buildingNo:'3',roomNo:'101',lane:'198弄',owner,owners:[owner],ownerId:1,ownerName:owner.name,ownerPhone:owner.phone};
 const tree=[{id:1,name:'测试小区',buildings:[{id:1,buildingNo:'3',lane:'198弄',houses:[house]}]}];
 export const fixtureRow={database:'parking2',recordId:'1',fields:{P_plate:'沪A00001',P_owner:'101',P_end:'2026-12-31',P_Effective:'000000000000001',P_Download:'000000000000001'},pmsMatch:{userId:1,houseId:1,name:owner.name,phone:owner.phone,roomLabel:'3号101'}};
 window.__entryCalls=[];
 export const address={tree:async()=>tree};export const repairs=new Proxy({}, {get:(_,name)=>async()=>{throw Error('不应调用报修写入 '+String(name));}});
 export const accessCardIssuance=new Proxy({}, {get:(_,name)=>async(...args)=>{window.__entryCalls.push({methodName:String(name),args});if(name==='deliyunVehiclesByPlate')return {rows:[]};if(name==='createParkingQuery'||name==='parkingQuery')return {id:1,status:'completed',term:'沪A00001',rows:[fixtureRow]};return {rows:[],status:'completed'};}});
 export async function request({url,method='GET',query={},data={}}){window.__entryCalls.push({url,method,query,data});
 if(url==='/owners-mgmt/business-contacts')return [structuredClone(owner)];
 if(url==='/owners-mgmt/1/business-contact'&&method==='PATCH'){Object.assign(owner,data);owner.phoneActivity=data.confirmedPhones.map(phone=>({phone,last_confirmed_at:'2026-11-12T00:00:00Z',confirmation_source:data.source}));return structuredClone(owner);}
 if(method!=='GET')throw Error('禁止非联系人业务写入：'+url);
 if(url==='/communities')return [{id:1,name:'测试小区'}];
 if(url==='/buildings')return [{id:1,communityId:1,buildingNo:'3',lane:'198弄'}];
 if(url==='/houses')return [house];
 if(url==='/vehicle-intakes/1')return {id:1,houseId:1,houseLabel:'测试小区/198弄3号/101',ownerName:owner.name,ownerPhone:owner.phone,kind:'paid',status:'submitted',plate:'沪A00001',contactName:owner.name,contactPhone:owner.phone,relation:'本人',vehicleClass:'small',garages:[],garageNumbers:{},expiresAt:'2026-12-01T00:00:00Z',qrValid:true,openedAt:null,submittedAt:'2026-11-12T00:00:00Z',reviewedAt:null,reviewNote:'',files:[],transaction:null,familyCarId:null,createdAt:'2026-11-12T00:00:00Z'};
 if(url==='/business/search')return {houses:[house],vehicles:[],accessCards:[]};
 if(url==='/business/rules')return [];if(url==='/business/household-parking')return {room:'3/101',roomTerm:'3/101',targets:[],localDatabases:[],deliyun:[]};
 if(url==='/fees/cashier/payment-methods')return ['cash'];
 if(url==='/fees/houses/1')return {standards:[]};
 if(url.includes('/today')||url.includes('/history')||url.includes('/bills'))return {rows:[],total:0,totalCents:0};
 return [];
 }`};});}}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=built.outputFiles.find(f=>f.path.endsWith('.css'))?.contents||'';
 const server=http.createServer((req,res)=>{if(req.url==='/entry.js'){res.setHeader('content-type','text/javascript');res.end(js);}else if(req.url==='/entry.css'){res.setHeader('content-type','text/css');res.end(css);}else{res.setHeader('content-type','text/html');res.end('<html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;const errors=[];const evidence=path.resolve(app,'../../outputs/business-owner-entry-implemented');fs.mkdirSync(evidence,{recursive:true});
 try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1080},timezoneId:'Asia/Shanghai'});page.setDefaultTimeout(8000);page.on('pageerror',e=>{errors.push(e.message);console.error('Entry browser runtime:',e.stack);});
 const origin=`http://127.0.0.1:${server.address().port}`;await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const results=[];
 for(const entry of ['cashier','apartment','vehicles','vehicle-existing','renew']){
 await page.goto(origin+'/'+(entry==='vehicle-existing'?'vehicles':entry)+(entry==='cashier'?'?intakeId=1':''));
 if(entry==='apartment'){await page.locator('.ant-select').filter({has:page.getByText('选择房号',{exact:true})}).getByRole('combobox').click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({hasText:/^101室?$/}).click();}
 if(entry==='vehicles'){await page.getByRole('button',{name:'新车登记',exact:true}).click();const picker=page.locator('.hp').getByRole('combobox');await picker.fill('101');await picker.press('Enter');}
  if(entry==='vehicle-existing'){await page.locator('.addr-search').getByRole('combobox').fill('沪A00001');await page.getByRole('button',{name:'查询',exact:true}).click();await page.locator('.veh-card').waitFor();}
 const contact=page.getByRole('region',{name:'业务联系人'});await contact.getByRole('button',{name:/业务联系人/}).waitFor();
 assert.equal((await page.evaluate(()=>window.__entryCalls)).filter(c=>c.method==='PATCH').length,0,entry+' does not write on opening');
 await contact.getByRole('button',{name:/业务联系人/}).click();await contact.getByLabel('业主姓名',{exact:true}).waitFor();
 assert.equal(await contact.getByLabel('业主姓名',{exact:true}).inputValue(),'入口测试业主');
 await contact.getByLabel('本次已核实 021-12345678',{exact:true}).check();await contact.getByRole('button',{name:'保存联系人与本次确认',exact:true}).click();await page.waitForFunction(()=>window.__entryCalls.some(c=>c.method==='PATCH'&&c.url==='/owners-mgmt/1/business-contact'));if(entry==='vehicle-existing'){await page.locator('.veh-card').waitFor();await contact.getByRole('button',{name:/业务联系人/}).click();await contact.getByLabel('业主姓名',{exact:true}).waitFor();}else{await contact.getByText('联系人已保存，只有本次勾选的号码记录为已确认',{exact:true}).waitFor();}
 const calls=await page.evaluate(()=>window.__entryCalls),writes=calls.filter(c=>c.method==='PATCH');assert.equal(writes.length,1);assert.deepEqual(writes[0].data.confirmedPhones,['021-12345678']);assert.equal(writes[0].data.source,entry==='cashier'||entry==='apartment'?'cashier':'parking');
 assert.equal(calls.filter(c=>c.method&&c.method!=='GET'&&c.method!=='PATCH').length,0);assert.equal(calls.filter(c=>/execute|complete|issue|renew|addVehicle/i.test(c.methodName||'')).length,0);
 await contact.screenshot({path:path.join(evidence,entry+'-contacts.png')});results.push({entry,contactWrites:1,confirmationSource:writes[0].data.source,businessWrites:0});
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify({fixtureOnly:true,realEntryComponents:true,realApiOrAuthOrDatabase:false,results,errors},null,2));
 }catch(e){fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({errors,message:e.message},null,2));if(browser){for(const context of browser.contexts())for(const page of context.pages())await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw e;}
 finally{await browser?.close();await new Promise(r=>server.close(r));}
});
