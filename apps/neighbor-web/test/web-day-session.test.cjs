const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const TOKEN='pms.admin.token';
const keys=['token','user','access','actingTenant','actingOffice'].map(k=>'pms.admin.'+k);
const token=(exp, id=1)=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,exp})).toString('base64url')+'.synthetic';
function memory(){const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)}}
function load(store=memory(), initial=Date.parse('2026-11-05T12:00:00+08:00'), navigation='reload') {
 let now=initial, seq=0, notifications=0; const timers=new Map(), allCallbacks=[];
 const events={}; const target=name=>({addEventListener:(name,fn)=>(events[name]??=[]).push(fn)});
 const FakeDate=class extends Date {static now(){return now}};
 const mod={exports:{}};
 const window={...target(),sessionStorage:store,performance:{getEntriesByType:()=>navigation==null?[]:[{type:navigation}]}}; const document={...target(),visibilityState:'visible'};
 const context={window,document,Date:FakeDate,queueMicrotask,atob:s=>Buffer.from(s,'base64').toString('binary'),exports:mod.exports,module:mod,
  setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});allCallbacks.push(fn);return id},clearTimeout:id=>timers.delete(id),
  require:name=>{if(name==='react')return {useSyncExternalStore:(subscribe,read)=>{subscribe(()=>notifications++);return read()}};throw Error(name)}};
 const file=path.resolve(__dirname,'../src/lib/auth.ts');
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 mod.exports.useSession();
 return {...mod.exports,store,allCallbacks,notifications:()=>notifications,fire:name=>(events[name]??[]).forEach(f=>f()),
  jump:ms=>{now=ms}, advance:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}}};
}
const exp=Date.parse('2026-11-06T00:00:00+08:00')/1000;
const login=(h,id=1,expires=exp)=>h.auth.setLogin({accessToken:token(expires,id),user:{id,tenantId:3,name:'fixture'}});

for(const navigation of ['navigate','back_forward',null])test(`新文档${navigation}不得恢复旧凭据；只有刷新可续用`,()=>{
 const h=load();login(h);const resumed=load(h.store,Date.parse('2026-11-05T12:01:00+08:00'),navigation);
 assert.equal(resumed.auth.getToken(),undefined);assert.equal(resumed.auth.getUser(),null);
 login(resumed);assert.ok(resumed.auth.getToken(),'新文档完成新登录后可正常使用');
});

test('无活动不退出；北京时间零点真实清理存储并通知UI，无需发请求',()=>{
 const h=load();login(h);h.auth.setAccess({communityIds:[1]},h.auth.captureIdentity());h.auth.setActingTenant({id:3,name:'A'});
 h.advance(11*3600000);assert.ok(h.auth.getToken());const n=h.notifications();
 h.advance(3600000);assert.equal(h.store.getItem(TOKEN),null);assert.equal(h.auth.getUser(),null);assert.equal(h.auth.getAccess(),null);
 assert.ok(h.notifications()>n,'到期必须通知React订阅者');for(const k of keys)assert.equal(h.store.getItem(k),null);
});

test('切换账号必须清除前账号权限、代操作租户和管理处',()=>{
 const h=load();login(h);h.auth.setAccess({communityIds:[99]},h.auth.captureIdentity());h.auth.setActingTenant({id:8,name:'old'});h.auth.setActingOffice({id:9,name:'old'});
 login(h,2);assert.equal(h.auth.getUser().id,2);assert.equal(h.auth.getAccess(),null);assert.equal(h.auth.getActingTenant(),null);assert.equal(h.auth.getActingOffice(),null);
});


test('请求先读到过期token也必须通知UI，不能使后续timer失去登出通知',async()=>{
 const h=load();login(h);const n=h.notifications();h.jump(exp*1000);
 assert.equal(h.auth.getToken(),undefined);await Promise.resolve();assert.ok(h.notifications()>n);
});

test('刷新重新加载模块保留sessionStorage；手动退出完整清除且通知UI',()=>{
 const h=load();login(h);h.auth.setAccess({communityIds:[3]},h.auth.captureIdentity());
 const refreshed=load(h.store);assert.equal(refreshed.auth.getUser().id,1);assert.ok(refreshed.auth.getAccess());
 const n=refreshed.notifications();refreshed.auth.clear();assert.ok(refreshed.notifications()>n);
 for(const k of keys)assert.equal(h.store.getItem(k),null);assert.equal(load(h.store).auth.getToken(),undefined);
});
test('隐藏/休眠时定时器未运行，恢复事件仍按deadline清理并通知UI',()=>{
 for(const event of ['focus','pageshow','visibilitychange']){
  const h=load();login(h);const n=h.notifications();h.jump(exp*1000);h.fire(event);
  assert.equal(h.store.getItem(TOKEN),null,event);assert.equal(h.auth.getUser(),null);assert.ok(h.notifications()>n);
 }
});
test('旧定时器不能清除新账号，即使回到同一token也不复活旧代次',()=>{
 const h=load();login(h);const old=h.allCallbacks.at(-1);login(h,2,exp+86400);
 h.jump(exp*1000);old();assert.equal(h.auth.getUser().id,2);assert.ok(h.auth.getToken());
 h.auth.clear();login(h,1,exp+86400);old();assert.equal(h.auth.getUser().id,1);
});
test('23:59:59、月末年末到期边界；过期启动、损坏token和孤立用户数据拒绝保留',()=>{
 for(const midnight of ['2026-11-06T00:00:00+08:00','2026-12-01T00:00:00+08:00','2027-01-01T00:00:00+08:00']){
  const ms=Date.parse(midnight),h=load(memory(),ms-1000);login(h,1,ms/1000);
  h.advance(999);assert.ok(h.auth.getToken());h.advance(1);assert.equal(h.auth.getToken(),undefined);
  const storage=memory();storage.setItem(TOKEN,token(ms/1000));storage.setItem(keys[1],JSON.stringify({id:1}));assert.equal(load(storage,ms).auth.getUser(),null);
 }
 for(const invalid of [null,'broken',token(Infinity)]){const storage=memory();if(invalid)storage.setItem(TOKEN,invalid);storage.setItem(keys[1],'{}');storage.setItem(keys[2],'{}');const h=load(storage);assert.equal(h.auth.getUser(),null);assert.equal(h.auth.getAccess(),null)}
});
