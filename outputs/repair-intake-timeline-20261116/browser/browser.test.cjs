const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../../..');
const app=path.join(root,'apps/neighbor-web');
const req=createRequire(path.join(app,'package.json'));
const {chromium}=req('playwright-core');
const esbuild=createRequire(req.resolve('vite'))('esbuild');
const png=fs.readFileSync(path.join(__dirname,'synthetic-photo.png'));
const sourcePaths=['NewOrderSheet','PhotoField','HousePicker','HouseAddressPicker','WorkOrderSheet'].map(n=>'apps/neighbor-web/src/components/'+n+'.tsx').concat('apps/neighbor-web/src/lib/upload.ts');
const hashes=()=>sourcePaths.map(p=>({path:p,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(run){
 const sourceHashes=hashes();fs.writeFileSync(path.join(__dirname,'tested-source-hashes.json'),JSON.stringify(sourceHashes,null,2));
 // Bundle only this isolated actual-component harness, never production artifacts.
 const originalTemp=process.env.TEMP,originalTmp=process.env.TMP;
 const temp=path.join(__dirname,'intentionally-absent-esbuild-'+process.pid); assert.ok(!fs.existsSync(temp)); process.env.TEMP=temp;process.env.TMP=temp;
 const built=await esbuild.build({entryPoints:[path.join(__dirname,'fixture.tsx')],bundle:true,write:false,format:'iife',jsx:'automatic',outfile:path.join(__dirname,'fixture.js'),
  alias:{'react':path.dirname(req.resolve('react/package.json')),'react-dom':path.dirname(req.resolve('react-dom/package.json')),'@':path.join(app,'src'),'@pms/shared-types':path.join(root,'packages/shared-types/src/index.ts')},
  plugins:[{name:'isolated-api-auth',setup(b){
   b.onResolve({filter:/^@pms\/api-client$/},()=>({path:path.join(__dirname,'fixture-api.ts')}));
   b.onResolve({filter:/^(?:@\/lib\/auth|\.\/auth)$/},()=>({path:'auth',namespace:'synthetic'}));
   b.onLoad({filter:/.*/,namespace:'synthetic'},()=>({loader:'ts',contents:`export const auth={getToken:()=> 'synthetic-token',getActingTenant:()=>({id:7})}; export const useSession=()=>({user:{id:9,role:'office'},access:{scopeAll:true,pages:{'work-orders':'edit'},communityIds:[81,82]}});`}));
  }}],define:{'process.env.NODE_ENV':'"test"','import.meta.env.VITE_API_BASE_URL':'"/fixture-upload"','import.meta.env.BASE_URL':'"/"','import.meta.env.VITE_LEGACY_BASE':'""'}});
 assert.ok(!fs.existsSync(temp));
 if(originalTemp===undefined)delete process.env.TEMP;else process.env.TEMP=originalTemp;if(originalTmp===undefined)delete process.env.TMP;else process.env.TMP=originalTmp;
 const resources=new Map(built.outputFiles.map(f=>['/'+path.basename(f.path),f.contents]));
 const state={creates:[],uploads:[],stored:null,failCreate:false,failUpload:false,slowUpload:false,held:[],details:0};
 const server=http.createServer(async(q,s)=>{
  const u=new URL(q.url,'http://127.0.0.1');const json=(code,data)=>{s.writeHead(code,{'Content-Type':'application/json'});s.end(JSON.stringify(data));};
  if(u.pathname==='/fixture-api/create'){
   const chunks=[];for await(const c of q)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks));state.creates.push(data);
   if(state.failCreate){state.failCreate=false;return json(400,{message:'合成提交失败，请核对后重试'});}
   state.stored=JSON.parse(JSON.stringify(data));await delay(300);return json(200,{request:{id:501},workOrder:{id:901,orderNo:'SYN-901'}});
  }
  if(u.pathname==='/fixture-api/detail'){
   state.details++;const d=state.stored||{};
   return json(200,{request:{...d,id:501},workOrder:{id:901,requestId:501,communityId:d.communityId,status:'created',orderNo:'SYN-901',summaryContent:d.content,summaryAddress:d.addressText,createdAt:'2026-11-16T01:00:00Z',candidateIds:[],photos:[],missingMaterials:[],urgent:d.urgent},materialUsages:[],logs:[{id:1,action:'create',createdAt:'2026-11-16T01:00:00Z',operatorName:'合成登记员',toStatus:'created',note:'较早记录'},{id:3,action:'progress',createdAt:'2026-11-16T03:00:00Z',operatorName:'合成维修员',toStatus:'in_progress',note:'最新处理记录'},{id:2,action:'assign',createdAt:'2026-11-16T02:00:00Z',operatorName:'合成办公室',fromStatus:'created',toStatus:'dispatched',note:'中间派单记录'}],contact:{name:d.contactName,phone:d.contactPhone},repairTypeLabels:{},completionDraft:null});
  }
  if(u.pathname==='/fixture-upload/upload'){
   const chunks=[];for await(const c of q)chunks.push(c);state.uploads.push({authorization:q.headers.authorization,tenant:q.headers['x-acting-tenant-id'],contentType:q.headers['content-type'],bytes:Buffer.concat(chunks).length});
   const finish=()=>state.failUpload?(state.failUpload=false,json(500,{message:'合成图片上传失败'})):json(200,{data:{objectKey:'uploads/synthetic-'+state.uploads.length+'.png'}});
   if(state.slowUpload)state.held.push(finish);else finish();return;
  }
  if(u.pathname==='/fixture-upload/upload/file'){s.writeHead(200,{'Content-Type':'image/png'});s.end(png);return;}
  if(resources.has(u.pathname)){s.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':'text/css');s.end(resources.get(u.pathname));return;}
  if(u.pathname==='/'){s.setHeader('Content-Type','text/html;charset=utf-8');s.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');return;}
  s.writeHead(404);s.end();
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true}).catch(async e=>{console.error(e.stack);await new Promise(r=>server.close(r));throw e;});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:url});const errors=[];
 page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith(url)?route.continue():route.abort());
 try{await run(page,url,state);assert.deepEqual(errors,[],'actual React components must not crash');assert.deepEqual(hashes(),sourceHashes,'tested sources stayed frozen');}catch(e){await shot(page,'failure');fs.writeFileSync(path.join(__dirname,'failure.txt'),e.stack+'\n'+await page.locator('body').innerText());throw e;}
 finally{for(const f of state.held)f();await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(__dirname,'captured-boundary.json'),JSON.stringify(state,(k,v)=>k==='held'?undefined:v,2));}
}
const shot=(p,n)=>p.screenshot({path:path.join(__dirname,n+'.png'),fullPage:true});
const uploadFile=(name='photo.png')=>({name,mimeType:'image/png',buffer:png});
async function publicCommunity(page){
 await page.locator('.hp input').click();
 await page.locator('.ant-cascader-menu-item').filter({hasText:'合成空楼小区'}).click();
 await page.locator('.ant-cascader-menu-item').filter({hasText:'本小区公共区域'}).click();
 await page.getByLabel('具体位置',{exact:true}).fill('大门');
 await page.getByLabel('联系人',{exact:true}).fill('合成联系人');
 await page.getByLabel('手机号',{exact:true}).fill('13800138000');
 await page.getByRole('textbox',{name:'问题描述',exact:true}).fill('合成公共区域灯不亮');
}
// Final assertions are completed after lead confirms the implementation contract.
module.exports={fixture,shot,publicCommunity,uploadFile,png,delay,test,assert};
