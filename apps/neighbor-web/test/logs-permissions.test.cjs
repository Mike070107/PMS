const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'../src');
function runLogs(allowed){
 const requests=[],effects=[];const module={exports:{}};
 const react={useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect:fn=>effects.push(fn)};
 const session={user:{id:7,tenantId:1},access:{pages:{logs:{view:allowed}}}};
 const sandbox={module,exports:module.exports,console,setTimeout:fn=>{fn();return 1},clearTimeout(){},require(id){
  if(id==='react')return react;if(id==='react/jsx-runtime')return require(id);
  if(id==='@/lib/perm')return{can:()=>allowed};if(id==='@/lib/auth')return{useSession:()=>session};
  if(id==='@pms/api-client')return{request:o=>{requests.push(o);return Promise.resolve({list:[],total:0})}};
  if(id==='dayjs')return{__esModule:true,default:()=>({format:()=>''})};
  return{__esModule:true,default:'Icon',Loading:'Loading',legacyUrl:x=>x};
 }};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,'pages/Logs.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,sandbox);
 const ui=module.exports.default();for(const fn of effects)fn();return{ui,requests};
}
function text(n){if(n==null||typeof n==='boolean')return'';if(typeof n==='string'||typeof n==='number')return String(n);if(Array.isArray(n))return n.map(text).join('');return text(n.props?.children)}
test('日志导航显式绑定logs权限，侧栏及功能搜索使用同一过滤',()=>{const s=fs.readFileSync(path.join(root,'components/Shell.tsx'),'utf8');const nav=s.split('\n').find(l=>l.includes("key: 'logs'"));assert.match(nav,/permissionKey:\s*'logs'/);assert.ok((s.match(/can\([^)]*permissionKey/g)||[]).length>=2)});
test('直接进入日志地址也拒绝无查看权限账号，不发送日志或运行概况请求',()=>{const {ui,requests}=runLogs(false);assert.match(text(ui),/没有.*权限|无权/);assert.doesNotMatch(text(ui),/系统运行状况与操作记录|反馈处理/);assert.equal(requests.length,0)});
test('有日志查看权限账号仍能进入且正常请求两个接口',()=>{const {ui,requests}=runLogs(true);assert.match(text(ui),/系统运行状况与操作记录/);assert.deepEqual(requests.map(x=>x.url).sort(),['/observability/logs','/observability/overview'])});
