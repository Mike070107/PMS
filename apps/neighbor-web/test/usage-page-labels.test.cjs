const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const app=path.resolve(__dirname,'..'),root=path.resolve(app,'../..');
function compile(file,requireStub,extra=''){
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8')+extra,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require:requireStub||(()=>({})),console});return module.exports;
}
const labels=compile(path.join(app,'src/lib/page-labels.ts'));
const logs=compile(path.join(app,'src/pages/Logs.tsx'),id=>id==='@/lib/page-labels'?labels:{},'\nexport {normalizeUsage,drillRow};');
test('全部实际Web菜单均使用同名标签；只匹配完整已知路径不猜测未知子页',()=>{
 const shell=fs.readFileSync(path.join(app,'src/components/Shell.tsx'),'utf8');
 const menu=[...shell.matchAll(/\{ key: '[^']+'[^\n]*?name: '([^']+)'[^\n]*?to:\s*'([^']+)'/g)];
 assert.ok(menu.length>=35);
 for(const [,name,route]of menu)assert.equal(labels.usagePageLabel(route,route),name,route);
 assert.equal(labels.usagePageLabel('/work-orders/unknown'), '未知页面（/work-orders/unknown）');
 assert.equal(labels.usagePageLabel('/mystery', '独立中文功能'), '独立中文功能');
 assert.equal(labels.usagePageLabel(''), '未命名页面');
 assert.equal(labels.usagePageLabel('/future'), '未知页面（/future）');
 assert.equal(labels.usagePageLabel('/access-cards','门禁卡管理'), '门禁发卡');
});
test('员工/业主所有注册路由均有标签，非共用页与实际tab或标题完全相同',()=>{
 for(const [folder,prefix,map]of [['miniapp-staff','miniapp-staff',labels.STAFF_PAGE_LABELS],['miniapp-owner','miniapp-owner',labels.OWNER_PAGE_LABELS]]){
  const dir=path.join(root,'apps',folder,'miniprogram'),config=JSON.parse(fs.readFileSync(path.join(dir,'app.json'),'utf8'));
  const tabs=new Map(config.tabBar.list.map(x=>[x.pagePath,x.text]));
  for(const route of config.pages){const key=route.split('/')[1];assert.ok(map[key],route);assert.equal(labels.usagePageLabel('/'+prefix+'/'+key),map[key]);assert.equal(labels.usagePageLabel('/'+prefix+'/'+route+'?id=12#x'),map[key]);
   const titleFile=path.join(dir,route+'.json');if(!fs.existsSync(titleFile))continue;
   const title=tabs.get(route)||JSON.parse(fs.readFileSync(titleFile,'utf8')).navigationBarTitleText;
   if(folder==='miniapp-staff'&&['pool','approvals','me'].includes(key)){assert.ok(map[key].includes(title));continue;}
   assert.equal(map[key],title,route);
  }
 }
});
test('真实Logs两张榜同resolver：中文名、原始下钻路径与人数/占比/排名不变',()=>{
 const paths=['/miniapp-staff/pool','/miniapp-staff/order-detail','/miniapp-staff/my-orders','/miniapp-staff/me','/miniapp-staff/apartment-cashier','/access-cards','/future'];
 const raw={totalViews:100,uniqueUsers:8,topPages:paths.map((path,i)=>({path,name:path,views:20-i,users:3,share:0.1})),topUsers:paths.map((p,i)=>({name:'用户'+i,userId:i+1,views:9,pages:2,topPage:p,topPageName:p}))};
 const out=logs.normalizeUsage(raw);assert.equal(out.totalViews,100);assert.equal(out.uniqueUsers,8);assert.equal(out.topPages.length,paths.length);
 for(let i=0;i<paths.length;i++){const p=out.topPages[i],u=out.topUsers[i];assert.equal(p.name,labels.usagePageLabel(paths[i]));assert.equal(u.topPage,p.name);assert.equal(p.path,paths[i]);assert.equal(u.topPagePath,paths[i]);assert.equal(p.views,20-i);assert.equal(p.users,3);assert.equal(p.share,10);}
 assert.equal(logs.normalizeUsage({topUsers:[{topPage:'/future',topPageName:'未来功能'}]}).topUsers[0].topPage,'未来功能');
 const p='/miniapp-staff/order-detail';assert.equal(logs.drillRow('user-events',{path:p,time:'t'})[1],'工单详情');assert.equal(logs.drillRow('user-pages',{path:p,count:5})[0],'工单详情');
});
