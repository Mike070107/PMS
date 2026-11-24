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
test('新车登记业主信息只读；正式收银/公寓/已存车牌/续费可逐号确认，加载不写且不触发收费/设备动作',async()=>{
 const built=await esbuild.build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import {App,ConfigProvider} from 'antd';import Cashier from '@/pages/Cashier';import ApartmentCashier from '@/pages/ApartmentCashier';import Vehicles from '@/pages/Vehicles';import RenewSheet,{RenewalCheckout} from '@/components/vehicle-ops/RenewSheet';import {fixtureRow} from '@pms/api-client';import '@/styles/design.css';import '@/styles/app.css';
 const route=location.pathname;createRoot(document.getElementById('root')).render(<BrowserRouter><ConfigProvider><App>{(route==='/cashier'||route==='/plate-only')?<Cashier/>:route==='/apartment'?<ApartmentCashier/>:route==='/vehicles'?<Vehicles/>:route==='/inline-renew'?<RenewalCheckout plate="沪A00001" rows={[fixtureRow]} cloud={null} onClose={()=>{}} onDone={()=>{}}/>:<RenewSheet plate="沪A00001" rows={[fixtureRow]} cloud={null} onClose={()=>{}} onDone={()=>{}}/>}</App></ConfigProvider></BrowserRouter>);`,loader:'tsx',resolveDir:app},bundle:true,write:false,outfile:'entry.js',format:'iife',jsx:'automatic',alias:{'@':path.join(app,'src')},define:{'process.env.NODE_ENV':'"development"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""','import.meta.env.VITE_API_BASE_URL':'"/api/v1"'},plugins:[{name:'entry-fixtures',setup(b){b.onResolve({filter:/^(@pms\/api-client|@\/lib\/auth|@\/lib\/perm)$/},a=>({path:a.path,namespace:'entry-fixture'}));b.onLoad({filter:/.*/,namespace:'entry-fixture'},a=>{
 if(a.path.endsWith('/perm'))return {contents:`export const can=()=>true;`,loader:'js'};
 if(a.path.endsWith('/auth'))return {contents:`const session={user:{id:1,name:'测试收费员'},access:{isTenantAdmin:true,scopeAll:true,communityIds:[1]}};export const useSession=()=>session;`,loader:'js'};
 return {loader:'js',contents:`
 const owner={id:1,name:'入口测试业主',phone:'13800000001',contactPhones:['13800000001','021-12345678']};
 const house={id:1,buildingId:1,communityId:1,communityName:'测试小区',buildingNo:'3',roomNo:'101',lane:'198弄',owner,owners:[owner],ownerId:1,ownerName:owner.name,ownerPhone:owner.phone};
 const tree=[{id:1,name:'测试小区',buildings:[{id:1,buildingNo:'3',lane:'198弄',houses:[house]}]}];
 export const fixtureRow={database:'parking2',recordId:'1',fields:{P_plate:'沪A00001',P_owner:'101',P_end:'2026-12-31',P_Effective:'000000000000001',P_Download:'000000000000001'},pmsMatch:{userId:1,houseId:1,name:owner.name,phone:owner.phone,roomLabel:'3号101'}};
 window.__entryCalls=[];
 export const uploadBlobTo=async()=>{throw Error('禁止在联系人只读入口测试上传附件');};
 const plateMode=location.pathname==='/plate-only';export const address={tree:async()=>plateMode?[{...tree[0],id:2,name:'枫桦景苑二期'}]:tree};export const repairs=new Proxy({}, {get:(_,name)=>async()=>{throw Error('不应调用报修写入 '+String(name));}});
 export const accessCardIssuance=new Proxy({}, {get:(_,name)=>async(...args)=>{window.__entryCalls.push({methodName:String(name),args});if(plateMode&&name==='createParkingQuery')return {id:704,status:'completed',rows:[{database:'parking2',fields:{P_id:19,P_plate:'沪AAV7788',P_Effective:'0000000000100',Owner__owner_Name:'198/23/102测试姓名',End_Time:'2026-12-31'}}]};if(name==='deliyunVehiclesByPlate')return {rows:[]};if(name==='createParkingQuery'||name==='parkingQuery')return {id:1,status:'completed',term:'沪A00001',rows:[fixtureRow]};return {rows:[],status:'completed'};}});
 export async function request({url,method='GET',query={},data={}}){window.__entryCalls.push({url,method,query,data});
 if(url==='/owners-mgmt/business-contacts')return [structuredClone(owner)];
 if(url==='/owners-mgmt/1/business-contact'&&method==='PATCH'){Object.assign(owner,data);owner.phoneActivity=data.confirmedPhones.map(phone=>({phone,last_confirmed_at:'2026-11-12T00:00:00Z',confirmation_source:data.source}));return structuredClone(owner);}
 if((plateMode||location.pathname==='/inline-renew')&&url==='/business/estimate')return {quantity:12,amountCents:150000,startDate:'2027-01-01',endDate:'2027-12-31'};
 if((plateMode||location.pathname==='/inline-renew')&&url==='/business/complete')return {id:99,txnNo:'TEST-INLINE',externalSyncStatus:'queued'};
 if(method!=='GET')throw Error('禁止非联系人业务写入：'+url);
 if(url==='/communities')return [{id:1,name:'测试小区'}];
 if(url==='/buildings')return [{id:1,communityId:1,buildingNo:'3',lane:'198弄'}];
 if(url==='/houses')return [house];
 if(url==='/vehicle-intakes/1')return {id:1,houseId:1,houseLabel:'测试小区/198弄3号/101',ownerName:owner.name,ownerPhone:owner.phone,kind:'paid',status:'submitted',plate:'沪A00001',contactName:owner.name,contactPhone:owner.phone,relation:'本人',vehicleClass:'small',garages:[],garageNumbers:{},expiresAt:'2026-12-01T00:00:00Z',qrValid:true,openedAt:null,submittedAt:'2026-11-12T00:00:00Z',reviewedAt:null,reviewNote:'',files:[],transaction:null,familyCarId:null,createdAt:'2026-11-12T00:00:00Z'};
 if(url==='/fees/mis/postings/readiness')return {enabled:false,methods:[],reason:'演练'};
 if(url==='/fees/mis/bills')return {rows:[{id:'101',feeCode:'01',feeName:'物业费',amountCents:9900},{id:'102',feeCode:'14',feeName:'停车管理费',amountCents:6750},{id:'103',feeCode:'04',feeName:'泊位费',amountCents:8000}].map(r=>({...r,period:'202611',remark:'',status:query.status})),total:3};
 if(url==='/access-card-issuance/cards/history')return {status:'completed',rows:[{id:17,sequence:1,icCardNo:'00007777',roomLabel:'3/101',source:'legacy',communityId:1}],refreshedAt:'2026-11-20T02:00:00Z'};
 if(plateMode&&url==='/business/search')return {houses:[],vehicles:[],accessCards:[]};if(url==='/business/search')return {houses:[house],vehicles:location.pathname==='/inline-renew'?[{id:7,plateNo:'沪A00001',houseId:1}]:[],accessCards:[]};
 if(url==='/business/parking-spaces'||/^\\/vehicle-intakes\\/\\d+\\/parking-spaces$/.test(url))return {rows:[]};
 if(plateMode&&url==='/business/rules')return [{id:4,serviceType:'parking_monthly',enabled:true,communityId:2,unitPriceCents:15000,name:'住户车1',config:{}}];if(url==='/business/rules')return location.pathname==='/inline-renew'?[{id:4,serviceType:'parking_monthly',enabled:true,communityId:1,unitPriceCents:15000,name:'住户车1',config:{vehicleClass:'住户车1'}}]:[];if(plateMode&&url==='/business/household-parking')throw Error('无房号不能按虚构房屋查询');if(url==='/business/household-parking')return {room:'3/101',roomTerm:'3/101',targets:[],localDatabases:location.pathname==='/inline-renew'?['parking2']:[],deliyun:[]};
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
 if(entry==='vehicles'){
   await page.getByRole('dialog').getByText('业主：入口测试业主', { exact: true }).waitFor();
   assert.equal(await page.getByRole('region',{name:'业务联系人'}).count(),0,'new registration cannot edit owner master contacts');
   const calls=await page.evaluate(()=>window.__entryCalls);
   assert.equal(calls.filter(c=>c.method&&c.method!=='GET').length,0);
   assert.equal(calls.filter(c=>/execute|complete|issue|renew|addVehicle/i.test(c.methodName||'')).length,0);
   await page.getByRole('dialog').screenshot({path:path.join(evidence,entry+'-contacts.png')});
   results.push({entry,ownerContactsReadOnly:true,contactWrites:0,businessWrites:0});continue;
  }
  const contact=page.getByRole('region',{name:'业务联系人'});await contact.getByRole('button',{name:/业务联系人/}).waitFor();
 assert.equal((await page.evaluate(()=>window.__entryCalls)).filter(c=>c.method==='PATCH').length,0,entry+' does not write on opening');
 await contact.getByRole('button',{name:/业务联系人/}).click();await contact.getByLabel('业主姓名',{exact:true}).waitFor();
 assert.equal(await contact.getByLabel('业主姓名',{exact:true}).inputValue(),'入口测试业主');
 await contact.getByLabel('本次已核实 021-12345678',{exact:true}).check();await contact.getByRole('button',{name:'保存联系人与本次确认',exact:true}).click();await page.waitForFunction(()=>window.__entryCalls.some(c=>c.method==='PATCH'&&c.url==='/owners-mgmt/1/business-contact'));if(entry==='vehicle-existing'){await page.locator('.veh-card').waitFor();await contact.getByRole('button',{name:/业务联系人/}).click();await contact.getByLabel('业主姓名',{exact:true}).waitFor();}else{await contact.getByText('联系人已保存，只有本次勾选的号码记录为已确认',{exact:true}).waitFor();}
 const calls=await page.evaluate(()=>window.__entryCalls),writes=calls.filter(c=>c.method==='PATCH');assert.equal(writes.length,1);assert.deepEqual(writes[0].data.confirmedPhones,['021-12345678']);assert.equal(writes[0].data.source,entry==='cashier'||entry==='apartment'?'cashier':'parking');
 assert.equal(calls.filter(c=>c.method&&c.method!=='GET'&&c.method!=='PATCH').length,0);assert.equal(calls.filter(c=>/execute|complete|issue|renew|addVehicle/i.test(c.methodName||'')).length,0);
 await contact.screenshot({path:path.join(evidence,entry+'-contacts.png')});results.push({entry,contactWrites:1,confirmationSource:writes[0].data.source,businessWrites:0});
 }
 await page.setViewportSize({width:390,height:760});
 await page.goto(origin+'/inline-renew');
 const renewal=page.getByRole('dialog',{name:'续期收费 · 沪A00001'});
 await renewal.getByRole('row',{name:/沪A00001/}).getByRole('checkbox').check();
 await renewal.getByRole('button',{name:/确认到账/}).click();
 await renewal.getByRole('button',{name:/^确认收款/}).click();
 await renewal.getByRole('heading',{name:'收款已登记'}).waitFor();
 assert.equal(new URL(page.url()).pathname,'/inline-renew');
 const posted=(await page.evaluate(()=>window.__entryCalls)).filter(c=>c.url==='/business/complete');
 assert.equal(posted.length,1);assert.equal(posted[0].data.plateNo,'沪A00001');
 assert.equal(await renewal.getByText('TEST-INLINE',{exact:false}).count(),1);
 await page.goto(origin+'/plate-only');
 await page.getByRole('combobox').first().fill('7788');
 await page.getByRole('button',{name:/沪AAV7788.*房号待核对/s}).click();
 await page.getByText('按车牌续费 · 沪AAV7788',{exact:true}).waitFor();
 await page.goto(origin+`/plate-only?renewPlate=${encodeURIComponent('沪AAV7788')}`);
 await page.getByText('按车牌续费 · 沪AAV7788',{exact:true}).waitFor();
 await page.getByText('现场查询完成',{exact:true}).waitFor();
 await page.getByText('旧库房号 198/23/102测试姓名 · 按现场车牌续费',{exact:true}).waitFor();
 const unlinked = page.getByRole('row',{name:/沪AAV7788/});
 await unlinked.getByRole('checkbox').check();
 await page.getByText('车辆管理 · 沪AAV7788',{exact:true}).click();
 await page.getByRole('button',{name:'注销车辆',exact:true}).click();
 const cancellation=page.getByRole('dialog',{name:'注销车辆 · 沪AAV7788'});
 assert.equal(await cancellation.getByRole('button',{name:'确认注销'}).isDisabled(),true);
 await cancellation.getByRole('checkbox').check();
 assert.equal(await cancellation.getByRole('button',{name:'确认注销'}).isEnabled(),true);
 await cancellation.getByRole('button',{name:'取消'}).click();
 assert.equal((await page.evaluate(()=>window.__entryCalls)).filter(call=>call.methodName==='createParkingOperation').length,0);
 assert.equal(await page.getByRole('button',{name:/^确认收款/}).isDisabled(),true);
 await page.getByRole('button',{name:/确认到账/}).click();
 await page.getByRole('button',{name:/^确认收款/}).click();
 await page.getByRole('heading',{name:'收款已登记'}).waitFor();
 const plateOnlyCalls=await page.evaluate(()=>window.__entryCalls);
 const receiptCalls=plateOnlyCalls.filter(call=>call.url==='/business/complete');
 assert.equal(plateOnlyCalls.filter(call=>call.url==='/business/household-parking').length,0);
 assert.equal(receiptCalls.length,1);
 assert.equal(receiptCalls[0].data.plateNo,'沪AAV7788');
 assert.equal(receiptCalls[0].data.houseId,undefined);
 assert.equal(receiptCalls[0].data.parkingSystems[0].sourceRecordId,'19');
 assert.equal(receiptCalls[0].data.parkingSystems[0].queryId,704);
 await page.screenshot({path:path.join(evidence,'plate-only-receipt-390.png')});
 await page.setViewportSize({width:1440,height:1080});
 await page.goto(origin+'/cashier?intakeId=1');
 const tabs=page.locator('.cashier-projects');
 for (const [label,amount] of [['物业费','99.00'],['泊位费','80.00'],['车位管理费','67.50']]) {
   await tabs.getByRole('button',{name:new RegExp(label)}).click();
   const row=page.locator('button.cashier-bill');
   await row.filter({hasText:amount}).waitFor();
   assert.equal(await row.count(),1);
   assert.ok((await row.boundingBox()).height<60,'普通待缴项应在一行内');
   await row.click(); assert.equal(await row.getAttribute('aria-pressed'),'false');
   await row.click(); assert.equal(await row.getAttribute('aria-pressed'),'true');
 }
 await page.screenshot({path:path.join(evidence,'cashier-garage-desktop.png')});
 await page.setViewportSize({width:390,height:680});
 assert.ok(await page.locator('button.cashier-bill').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await tabs.getByRole('button',{name:/门禁卡/}).click();
 await page.getByTestId('history-block').getByText('00007777',{exact:true}).first().waitFor();
 assert.equal(await page.getByTestId('recent-block').count(),0);
 await page.getByTestId('history-block').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(evidence,'cashier-card-mobile.png')});
 const query=await page.evaluate(()=>window.__entryCalls.find(x=>x.url==='/access-card-issuance/cards/history')?.query);
 assert.deepEqual(query,{communityId:1,address:'198弄/3/101'});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify({fixtureOnly:true,realEntryComponents:true,realApiOrAuthOrDatabase:false,results,errors},null,2));
 }catch(e){fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({errors,message:e.message},null,2));if(browser){for(const context of browser.contexts())for(const page of context.pages())await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});}throw e;}
 finally{await browser?.close();await new Promise(r=>server.close(r));}
});
