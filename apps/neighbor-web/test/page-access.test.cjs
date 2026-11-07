const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'../src');
function load(file,access,pathname='/houses',options={}){
 const session={token:'synthetic-token',generation:1,user:{id:7,tenantId:1,name:'合成账号'},access};
 const identity={token:session.token,generation:1};
 let stateIndex=0;
 const react={useState:v=>{const i=stateIndex++;return[options.states&&i in options.states?options.states[i]:options.verified&&v===null?identity:typeof v==='function'?v():v,value=>options.writes?.push({index:i,value})]},useCallback:f=>f,useMemo:f=>f(),useEffect:(f,deps)=>{options.effects?.push(f);options.dependencies?.push(deps)},lazy:()=>()=>null,Suspense:'Suspense'};
 const module={exports:{}};const jsx=(type,props)=>({type,props});
 const source=fs.readFileSync(path.join(root,file),'utf8').replaceAll('import.meta.env.BASE_URL',JSON.stringify('/'));
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,sessionStorage:{getItem:()=>null},window:{location:{pathname}},require(id){
  if(id==='react')return react;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx};
  if(id==='react-router-dom')return{Navigate:'Navigate',Route:'Route',Routes:'Routes',Outlet:'Outlet',useLocation:()=>({pathname}),useNavigate:()=>()=>{}};
  if(id==='@/lib/auth')return{useSession:()=>session,auth:{getAccess:()=>access,captureIdentity:()=>identity,isCurrent:()=>false,...options.auth}};
  if(id==='@/lib/perm')return{can:k=>!!(access?.isTenantAdmin||access?.isPlatformAdmin||access?.pages?.[k]?.view)};
  if(id==='@/lib/page-access')return load('lib/page-access.ts',access,pathname);
  if(id==='@/components/UiPreferencesProvider')return{useUiPreferences:()=>({preferences:{sidebarCollapsed:false},update(){}})};
  if(id==='@/components/Shell')return{default:'Shell'};
  if(id==='@pms/shared-types')return{ADMIN_PAGES:[],STAFF_APP_PAGES:[],REPAIR_TYPE_OPTIONS:[],PAGE_GROUPS:[
   {title:'总览',pageKeys:[]},{title:'收费办理',pageKeys:[]},{title:'车辆管理',pageKeys:[]},{title:'门禁管理',pageKeys:[]},
   {title:'报修养护',pageKeys:[]},{title:'库存与盘点',pageKeys:[]},{title:'分析',pageKeys:[]},{title:'档案',pageKeys:[]},{title:'系统',pageKeys:[]},
  ]};
  if(id==='@pms/api-client'&&options.api)return options.api;
  if(id==='@pms/api-client')return{auth:{me:()=>new Promise(()=>{})},notifications:{unreadCount:()=>Promise.resolve({count:0})},address:{tree:()=>Promise.resolve([])},request:o=>{options.requests?.push(o.url);return Promise.resolve([])}};
  if(id==='@/lib/legacy')return{legacyUrl:x=>x};
  if(id==='@/lib/format')return{statusOf:()=>''};
  return{default:'Component',Loading:'Loading',Toaster:'Toaster'};
 }});return module.exports;
}
function nodes(n){if(!n||typeof n!=='object')return[];return[n,...[n.props?.children,n.props?.element].flat(Infinity).flatMap(nodes)]}
function text(n){if(n==null||typeof n==='boolean')return'';if(typeof n==='string'||typeof n==='number')return String(n);if(Array.isArray(n))return n.map(text).join('');return text(n.props?.children)}
test('ordinary user with no grants sees no business menu or group titles',()=>{
 const ui=load('components/Shell.tsx',{pages:{}}).default();
 const nav=nodes(ui).find(n=>n.type==='nav');assert.ok(nav);
 assert.equal(nodes(nav).filter(n=>n.type==='a').length,0);
 assert.equal(nodes(nav).filter(n=>n.type==='button').length,0);
 assert.doesNotMatch(text(nav),/收银台|员工与权限|系统设置|房产|日志/);
});
test('unauthorized direct address never creates the protected shell before permission verification',()=>{
 const ui=load('App.tsx',{pages:{}},'/houses').default();
 assert.equal(nodes(ui).filter(n=>n.type==='Shell').length,0);
});
test('all actual menu routes have explicit canonical page permissions',()=>{
 const nav=load('components/Shell.tsx',{pages:{}}).NAV;
 const map=load('lib/page-access.ts',{pages:{}});
 for(const item of nav){assert.ok(map.pageForPath(item.to),'unmapped '+item.key);assert.equal(map.canViewPath(item.to,{pages:{}}),false,item.key)}
 assert.equal(map.canViewPath('/unknown',{isTenantAdmin:true}),false);
 assert.equal(map.canViewPath('/houses-other',{pages:{properties:{view:true}}}),false);
});
test('route aliases and permissions match without granting unrelated sections',()=>{
 const m=load('lib/page-access.ts',{});
 const a={pages:{properties:{view:true}}};
 assert.equal(m.canViewPath('/houses',a),true);assert.equal(m.canViewPath('/cashier',a),false);
 assert.equal(m.firstAllowedPath(a),'/houses');
 assert.equal(m.canViewPath('/apartment-cashier',{pages:{'apartment-cashier':{view:true}}}),true);
 assert.equal(m.canViewPath('/parking/main',{pages:{business:{view:true}}}),true);
 assert.equal(m.canViewPath('/staff',{pages:{users:{view:true}}}),true);
 assert.equal(m.canViewPath('/logs',{pages:{logs:{edit:true}}}),false);
 assert.equal(m.firstAllowedPath({pages:{}}),null);
 });
 test('role-only staff page hides employee section and does not request employee data',()=>{
 const effects=[],requests=[];const ui=load('pages/Staff.tsx',{pages:{roles:{view:true}}},'/staff',{effects,requests,states:['staff',[],[],[],[]]}).default();
 effects.forEach(f=>f());
 assert.doesNotMatch(text(ui),/员工 0/);assert.match(text(ui),/业务角色/);
 assert.equal(requests.includes('/staff'),false);assert.equal(requests.includes('/roles'),true);
 });
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function shellEffect(access,options={}){
 const effects=[],dependencies=[],writes=[],calls=[];
 const api=options.api??{notifications:{unreadCount:()=>{calls.push('unread');return Promise.resolve({count:3})}},repairs:{badgeCounts:()=>{calls.push('badge');return Promise.resolve({dispatch:5,pool:7})}}};
 load('components/Shell.tsx',access,'/staff',{effects,dependencies,writes,api,auth:{isCurrent:()=>true,...options.auth}}).default();
 const index=effects.findIndex(f=>f.toString().includes('unreadCount'));
 assert.ok(index>=0,'exercise the real Shell request effect');
 return{run:effects[index],deps:dependencies[index],writes,calls};
}
test('Shell denies unauthorized badge requests, clears old counts, and retains own unread request',async()=>{
 const h=shellEffect({pages:{users:{view:true},'work-orders':{view:true}}});h.run();await settle();
 assert.deepEqual(h.calls,['unread']);
 assert.ok(h.writes.some(w=>w.value?.dispatch===0&&w.value?.accept===0),'clear previous identity badges');
 assert.ok(h.writes.some(w=>w.value===3),'own unread count preserved');
});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}};
for(const key of ['app:pool','app:dispatch','app:my-orders'])test('Shell badge server view grant '+key,async()=>{
 const access={pages:{[key]:{view:true}}},h=shellEffect(access);h.run();await settle();
 assert.deepEqual(h.calls,['unread','badge']);assert.ok(h.writes.some(w=>w.value?.dispatch===5&&w.value?.accept===7));
 assert.equal(h.deps.includes('synthetic-token'),true);assert.equal(h.deps.includes(1),true);assert.equal(h.deps.includes(access),true);
});
for(const mode of ['identity','access','cleanup'])for(const outcome of ['resolve','reject'])test(`Shell ignores stale badge ${outcome} after ${mode}`,async()=>{
 const access={pages:{'app:pool':{view:true}}},badge=deferred(),unread=deferred();let current=true,currentAccess=access;
 const h=shellEffect(access,{api:{notifications:{unreadCount:()=>unread.promise},repairs:{badgeCounts:()=>badge.promise}},auth:{isCurrent:()=>current,getAccess:()=>currentAccess}});
 const cleanup=h.run();await settle();h.writes.length=0;
 if(mode==='identity')current=false;else if(mode==='access')currentAccess={pages:{}};else cleanup();
 badge[outcome](outcome==='resolve'?{dispatch:99,pool:99}:new Error('synthetic failure'));unread.resolve({count:99});await settle();
 assert.equal(h.writes.length,0,'stale success/catch/unread must not write');
});
test('Shell does not start badge API after identity changes during dynamic import',async()=>{
 let current=true;const h=shellEffect({pages:{'app:pool':{view:true}}},{auth:{isCurrent:()=>current}});h.run();current=false;await settle();assert.deepEqual(h.calls,['unread']);
});
 test('employee-only staff page hides role templates and uses the assignable-role endpoint',()=>{
 const effects=[],requests=[];const ui=load('pages/Staff.tsx',{pages:{users:{view:true}}},'/staff',{effects,requests,states:['staff',[],[],[],[]]}).default();
 effects.forEach(f=>f());assert.doesNotMatch(text(ui),/业务角色 0|权限模板 0/);
 assert.equal(requests.includes('/roles/templates'),false);assert.equal(requests.includes('/roles'),false);assert.equal(requests.includes('/roles/assignable'),true);
 });
 test('property-only owner page hides registration audits rather than showing an empty audit panel',()=>{
 const effects=[],requests=[];const ui=load('pages/Owners.tsx',{pages:{properties:{view:true}}},'/owners',{effects,requests,states:['audit',[],[],[],0,false,'',null,null]}).default();
 effects.forEach(f=>f());assert.doesNotMatch(text(ui),/待核实|没有待核实/);assert.match(text(ui),/业主档案/);
 assert.equal(requests.includes('/owners/audits'),false);assert.equal(requests.includes('/owners-mgmt'),true);
 });
 test('business-only plate page hides unauthorized family-car section',()=>{
 const ui=load('pages/Plates.tsx',{pages:{business:{view:true}}},'/plates').default();
 const tabs=nodes(ui).filter(n=>n.type==='button').map(text);
 assert.match(text(ui),/车牌登记审核/);assert.equal(nodes(ui).some(n=>typeof n.type==='function'&&n.type.name==='IntakeList'),true);assert.equal(tabs.includes('亲情车'),false);
 });

// ── 权限体系回归：页面注册表/分组单一事实来源 + bills 独立授权 ──
function loadSharedPages(){
 const source=fs.readFileSync(path.resolve(__dirname,'../../../packages/shared-types/src/pages.ts'),'utf8');
 const module={exports:{}};
 new Function('module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(module,module.exports);
 return module.exports;
}
test('页面分组是权限界面与首页菜单的单一事实来源',()=>{
 const shared=loadSharedPages();
 const grouped=shared.PAGE_GROUPS.flatMap(g=>g.pageKeys);
 assert.deepEqual([...grouped].sort(),[...shared.ADMIN_PAGE_KEYS].sort(),'每个后台页面都必须有且仅有一个分组');
 assert.equal(new Set(grouped).size,grouped.length,'同一页面不能重复分组');
 const shell=load('components/Shell.tsx',{});
 assert.deepEqual([...shell.GROUPS.map(g=>g.title)],shared.PAGE_GROUPS.map(g=>g.title),'Shell 分组标题/顺序必须与 PAGE_GROUPS 一致');
 assert.deepEqual(shared.PAGE_GROUPS.map(g=>g.title),['总览','收费办理','车辆管理','门禁管理','报修养护','库存与盘点','分析','档案','系统']);
});
test('账单与待缴：独立页面权限，fees 不再放行 /bills，菜单按 bills 过滤',()=>{
 const map=load('lib/page-access.ts',{});
 assert.equal(map.canViewPath('/bills',{pages:{bills:{view:true}}}),true);
 assert.equal(map.canViewPath('/bills',{pages:{fees:{view:true}}}),false,'只有 fees 不能再打开账单与待缴');
 assert.equal(map.canViewPath('/fees',{pages:{fees:{view:true}}}),true,'物业费页仍按 fees');
 assert.equal(map.canViewPath('/reports',{pages:{fees:{view:true}}}),true,'收费报表仍按 fees');
 const nav=load('components/Shell.tsx',{pages:{}}).NAV;
 const bills=nav.find(n=>n.key==='bills');
 assert.equal(bills.permissionKey,'bills','菜单项必须绑定 bills 页面权限');
 const allowed=load('components/Shell.tsx',{pages:{bills:{view:true}}},'/bills').default();
 assert.equal(nodes(allowed).filter(n=>n.type==='a'&&n.props&&n.props.title==='账单与待缴').length,1,'有 bills 权限时菜单出现账单与待缴');
 const denied=load('components/Shell.tsx',{pages:{fees:{view:true}}},'/bills').default();
 assert.equal(nodes(denied).filter(n=>n.type==='a'&&n.props&&n.props.title==='账单与待缴').length,0,'只有 fees 时菜单不出现账单与待缴');
});
