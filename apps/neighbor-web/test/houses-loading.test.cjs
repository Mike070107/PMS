const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real page hooks/JSX in a deterministic runner, not React/browser E2E.
function harness() {
  let cursor = 0, dirty = false, ui;
  const slots = [], effects = [], requests = [];
  const session = {user: {id: 1}, access: {scopeAll: true}};
  const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const react = {
    useState(init) { const i=cursor++; if(!slots[i]) slots[i]={value:typeof init==='function'?init():init}; return [slots[i].value, next=>{const v=typeof next==='function'?next(slots[i].value):next;if(!Object.is(v,slots[i].value)){slots[i].value=v;dirty=true;}}]; },
    useRef(init) { const i=cursor++; return (slots[i]??={value:{current:init}}).value; },
    useMemo(fn,deps) {const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
    useEffect(fn,deps) {const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const request = o => new Promise((resolve,reject)=>requests.push({o,resolve,reject}));
  const module={exports:{}};
  const code=fs.readFileSync(path.resolve(__dirname,'../src/pages/Houses.tsx'),'utf8');
  const sandbox={module,exports:module.exports,console,Error,require(id){
    if(id==='react')return react;
    if(id==='react/jsx-runtime')return require(id);
    if(id==='@pms/api-client')return {request,address:{tree:()=>request({url:'/address-tree'})}};
    if(id==='@pms/shared-types')return {sortedBuildings:rows=>rows};
    if(id==='@/lib/auth')return {useSession:()=>session};
    if(id==='@/components/ui')return {Loading:'Loading',Sheet:'Sheet',ConfirmModal:'ConfirmModal',Field:'Field',toast(){}};
    return {__esModule:true,default:'Icon'};
  }};
  vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,sandbox);
  function render(){let n=0;do{dirty=false;cursor=0;ui=module.exports.default();while(effects.length)effects.shift()();assert.ok(++n<30,'render loop');}while(dirty);return ui;}
  function nodes(node=ui, list=[]){if(Array.isArray(node))node.forEach(v=>nodes(v,list));else if(node&&typeof node==='object'){list.push(node);if(node.props?.children!==undefined)nodes(node.props.children,list);}return list;}
  async function settle(){await new Promise(resolve=>setImmediate(resolve));return render();}
  return {render,requests,nodes,settle,session};
}
function text(node){if(node==null||typeof node==='boolean')return '';if(typeof node==='string'||typeof node==='number')return String(node);if(Array.isArray(node))return node.map(text).join('');return text(node.props?.children);}
const house=id=>({id,communityId:21,buildingId:1,roomNo:'101',propertyType:'住宅',buildingNo:'1',communityName:'示例公寓',owner:null,owners:[],archivedAt:null});

test('房产档案筛选只取小区元数据，不下载全量房屋业主地址树',()=>{
 const h=harness();h.render();const urls=h.requests.map(r=>r.o.url);
 assert.ok(urls.includes('/communities'));assert.ok(urls.includes('/houses'));assert.ok(!urls.includes('/address-tree'));
});
test('列表超时不显示共0套或没有匹配的房产，提供重试',async()=>{
 const h=harness();h.render();h.requests.find(r=>r.o.url==='/houses').reject(new Error('请求超时（15秒）'));
 const ui=await h.settle();const s=text(ui);assert.match(s,/请求超时/);assert.match(s,/重试/);assert.doesNotMatch(s,/共 0 套|没有匹配的房产/);
});
test('切换小区A→B→A时旧结果和旧finally不能覆盖当前加载',async()=>{
 const h=harness();h.render();const choose=id=>{h.nodes().find(n=>n.type==='select').props.onChange({target:{value:String(id)}});h.render();};
 choose(21);const old=h.requests.filter(r=>r.o.url==='/houses').at(-1);choose(22);choose(21);
 const fresh=h.requests.filter(r=>r.o.url==='/houses').at(-1);assert.notEqual(fresh,old);
 old.resolve({rows:[house(1)],total:99});await h.settle();assert.ok(h.nodes().some(n=>n.type==='Loading'));
 fresh.resolve({rows:[house(2)],total:1});const s=text(await h.settle());assert.match(s,/共 1 套/);assert.doesNotMatch(s,/共 99 套/);
});
test('第2页提交新搜索只请求第1页，不先请求旧页',async()=>{
 const h=harness();h.render();h.requests.find(r=>r.o.url==='/houses').resolve({rows:[house(1)],total:65});await h.settle();
 h.nodes().find(n=>n.type==='button'&&text(n)==='下一页').props.onClick();h.render();
 const last=h.requests.filter(r=>r.o.url==='/houses').at(-1);assert.equal(last.o.query.page,2);
 last.resolve({rows:[house(2)],total:65});await h.settle();
 h.nodes().find(n=>n.type==='input').props.onChange({target:{value:'101'}});h.render();const count=h.requests.length;
 h.nodes().find(n=>n.type==='button'&&text(n)==='查询').props.onClick();h.render();
 const next=h.requests.slice(count).filter(r=>r.o.url==='/houses');assert.equal(next.length,1);assert.equal(next[0].o.query.page,1);assert.equal(next[0].o.query.q,'101');
});
