const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, filename);
const read = p => fs.readFileSync(path.resolve(__dirname, '../src', p), 'utf8');
// Real page hooks/JSX, isolated requests: not browser/React scheduling or live fees.
function harness() {
  let cursor=0, dirty=false, ui;
  const slots=[], effects=[], requests=[], errors=[];
  const access={communityIds:[20,21]};
  const message={error:s=>errors.push(s),success(){},info:s=>errors.push(s)};
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const react={
    useState(init){const i=cursor++;if(!slots[i])slots[i]={value:typeof init==='function'?init():init};return [slots[i].value,next=>{const v=typeof next==='function'?next(slots[i].value):next;if(!Object.is(v,slots[i].value)){slots[i].value=v;dirty=true;}}];},
    useRef(init){const i=cursor++;return (slots[i]??={value:{current:init}}).value;},
    useMemo(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
    useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn();});}},
  };
  const request=o=>new Promise((resolve,reject)=>requests.push({o,resolve,reject}));
  const module={exports:{}};
  const antd=new Proxy({App:{useApp:()=>({message})},Input:Object.assign(function Input(){},{TextArea:'TextArea'}),Empty:Object.assign(function Empty(){},{PRESENTED_IMAGE_SIMPLE:'empty'})},{get:(o,k)=>o[k]||String(k)});
  vm.runInNewContext(ts.transpileModule(read('legacy/pages/ApartmentCashierPage.tsx'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,console,require(id){
    if(id==='react')return react;
    if(id==='react/jsx-runtime')return require(id);
    if(id==='antd')return antd;
    if(id==='@ant-design/icons')return new Proxy({},{get:(_,k)=>String(k)});
    if(id==='../lib/auth')return {useAuth:()=>({access}),usePagePerm:()=>({canEdit:true})};
    if(id==='../lib/api')return {request};
    if(id==='@pms/shared-types')return {...require('@pms/shared-types'),sortedHouses:rows=>rows};
    if(id==='dayjs')return {default:require('dayjs')};
    return {__esModule:true,default:'HouseAddressPicker',PaymentMethodIcon:'PaymentMethodIcon'};
  }});
  function render(){let n=0;do{dirty=false;cursor=0;ui=module.exports.default({});while(effects.length)effects.shift()();assert.ok(++n<30,'render loop');}while(dirty);return ui;}
  function nodes(node=ui,list=[]){if(Array.isArray(node))node.forEach(v=>{if(v!==undefined)nodes(v,list);});else if(node&&typeof node==='object'){list.push(node);if(node.props?.children!==undefined)nodes(node.props.children,list);}return list;}
  async function settle(){await new Promise(r=>setImmediate(r));return render();}
  function picker(){const p=nodes().find(n=>n.type==='HouseAddressPicker');assert.ok(p,'reachable apartment cashier must use shared HouseAddressPicker');return p.props;}
  function choose(value){picker().onChange(value);render();}
  return {render,nodes,requests,errors,settle,picker,choose,access};
}
const communityRows=[{id:20,name:'门店A'},{id:21,name:'门店B'}];
const building=(id,communityId=20)=>({id,communityId,buildingNo:String(id)});
const house=(id,buildingId=34,communityId=20)=>({id,buildingId,communityId,communityName:'门店A',buildingNo:String(buildingId),roomNo:String(id),fullAddress:null,owner:{id:1,name:'原联系人',phone:'13800000000'},owners:[]});
async function start(){const h=harness();h.render();h.requests.find(r=>r.o.url==='/communities').resolve(communityRows);await h.settle();return h;}

test('actual apartment route imports legacy cashier, not the unused page/MIS default export',()=>{
 assert.match(read('App.tsx'),/path="\/apartment"[^\n]*MigratedApartment/);
 assert.match(read('pages/MigratedApartment.tsx'),/legacy\/pages\/ApartmentCashierWorkspace/);
 assert.match(read('legacy/pages/ApartmentCashierWorkspace.tsx'),/import ApartmentCashierPage from '.\/ApartmentCashierPage'/);
 assert.doesNotMatch(read('App.tsx'),/import\(['"]@\/pages\/ApartmentCashier['"]\)/);
 assert.match(read('legacy/pages/ApartmentCashierWorkspace.tsx'),/import \{ BillsTab, HouseDetailModal, ReconTab, ReportTab \} from '.\/FeesPage'/);
});

test('contact save locks address and preserves same-room fee draft without extra room requests',async()=>{
 const h=await start();h.choose([20]);h.requests.filter(r=>r.o.url==='/buildings').at(-1).resolve([building(34),building(35)]);await h.settle();
 h.choose([20,34]);h.requests.filter(r=>r.o.url==='/houses').at(-1).resolve([house(101)]);await h.settle();h.choose([20,34,101]);
 const name=()=>h.nodes().find(n=>n.props?.maxLength===60);
 assert.equal(name().props.value,'原联系人');
 const fee=h.nodes().find(n=>n.type==='button'&&n.props.className==='rent ');assert.ok(fee);fee.props.onClick();h.render();
 name().props.onChange({target:{value:'手工联系人'}});h.render();name().props.onBlur();h.render();
 const save=h.requests.find(r=>r.o.method==='PATCH');assert.ok(save);assert.equal(save.o.data.ownerName,'手工联系人');
 h.choose([21]);assert.deepEqual(Array.from(h.picker().value),[20,34,101]);
 save.resolve({owner:{id:1,name:'手工联系人',phone:'13800000000'}});await h.settle();
 assert.equal(name().props.value,'手工联系人');
 assert.ok(h.nodes().some(n=>n.type==='button'&&n.props.className==='rent active'));
 assert.equal(h.requests.filter(r=>r.o.url==='/houses').length,1);
 h.choose([20,35]);assert.deepEqual(Array.from(h.picker().value),[20,35]);
 assert.equal(name().props.value,'');assert.ok(h.nodes().some(n=>n.type==='button'&&n.props.className==='rent '));
});

test('clearing during branch loading clears the spinner and does not revive old data',async()=>{
 const h=await start();h.choose([20]);const old=h.requests.filter(r=>r.o.url==='/buildings').at(-1);
 h.choose([]);assert.equal(h.picker().loading,false);
 old.resolve([building(34)]);await h.settle();assert.equal(h.picker().value.length,0);
 assert.equal(h.requests.filter(r=>r.o.url==='/houses').length,0);
});

test('late A branch response cannot overwrite A→B→A selection or loading',async()=>{
 const h=await start();h.choose([20]);const old=h.requests.filter(r=>r.o.url==='/buildings').at(-1);
 h.choose([21]);h.choose([20]);const fresh=h.requests.filter(r=>r.o.url==='/buildings').at(-1);
 old.resolve([building(999)]);await h.settle();
 assert.equal(h.picker().communities.find(c=>c.id===20).buildings.length,0);
 assert.equal(h.picker().loading,true);
 fresh.resolve([building(34),building(35)]);await h.settle();h.choose([20,34]);
 const oldRooms=h.requests.filter(r=>r.o.url==='/houses').at(-1);
 h.choose([20,35]);const freshRooms=h.requests.filter(r=>r.o.url==='/houses').at(-1);
 oldRooms.resolve([house(999)]);await h.settle();assert.equal(h.picker().loading,true);
 assert.equal(h.picker().communities.find(c=>c.id===20).buildings.find(b=>b.id===35).houses.length,0);
 freshRooms.resolve([house(102,35)]);await h.settle();h.choose([20,35,102]);
 assert.deepEqual(Array.from(h.picker().value),[20,35,102]);
});

test('one shared address picker lazily loads selected branches, clears descendants and uses real room IDs only',async()=>{
 const h=await start();const p=h.picker();assert.equal(p.communities.length,2);
 assert.equal(h.requests.filter(r=>r.o.url==='/buildings'||r.o.url==='/houses'||r.o.url==='/address-tree').length,0);
 h.choose([20]);const br=h.requests.filter(r=>r.o.url==='/buildings');assert.equal(br.length,1);assert.equal(br[0].o.query.communityId,20);
 br[0].resolve([building(34),building(35)]);await h.settle();h.choose([20,34]);
 const hr=h.requests.filter(r=>r.o.url==='/houses');assert.equal(hr.length,1);assert.equal(hr[0].o.query.buildingId,34);
 hr[0].resolve([house(101)]);await h.settle();h.choose([20,34,101]);
 assert.deepEqual(Array.from(h.picker().value),[20,34,101]);
 assert.ok(h.requests.some(r=>r.o.url==='/fees/houses/101'));
 h.choose([20,34,'__unknown_house__']);assert.equal(h.picker().value.length,2);
 assert.ok(!h.requests.some(r=>r.o.url.includes('__unknown_house__')));
 h.choose([21]);assert.deepEqual(Array.from(h.picker().value),[21]);
 assert.equal(h.picker().communities.find(c=>c.id===20).buildings.length,0);
 assert.equal(h.requests.filter(r=>r.o.url==='/houses').length,1);
});
