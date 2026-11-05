const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
function make(){
 const state=[],effects=[],refs=[],requests=[],carts=[];let si=0,ei=0,ri=0,pending=[];let props;
 function Months(){}
 const react={useState(init){const i=si++;if(!(i in state))state[i]=i===1?18:init;return[state[i],v=>state[i]=typeof v==='function'?v(state[i]):v]},useMemo:f=>f(),useRef(init){const i=ri++;return refs[i]??(refs[i]={current:init})},useEffect(fn,deps){const i=ei++;if(!effects[i]||deps.some((v,j)=>v!==effects[i].deps[j]))pending.push({i,fn,deps})},useCallback:f=>f};
 const module={exports:{}};const jsx=(type,props)=>({type,props});
 const code=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/components/cashier/ParkingTab.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replaceAll('import.meta.env.BASE_URL', JSON.stringify('/'));
 vm.runInNewContext(code,{module,exports:module.exports,require(name){
  if(name==='react')return react;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};
  if(name==='@pms/api-client')return{request(o){let resolve,reject;const p=new Promise((yes,no)=>{resolve=yes;reject=no});requests.push({o,resolve,reject});return p},accessCardIssuance:{}};
  if(name==='@/lib/format')return{dayjs:require('dayjs'),money:n=>'¥'+n};
  if(name.endsWith('/RenewalMonths'))return{default:Months};return{default:()=>null};
 }});
 props={car:{plate:'SYNTHETIC',lots:[{key:'a',targetKey:'local:test',ref:{},label:'合成停车场',endDate:null}]},rules:[{id:18,serviceType:'parking_monthly',enabled:true,communityId:1,unitPriceCents:15000,config:{priceMode:'table',vehicleClass:'住户车-1',isDefault:true,tiers:[{months:1,amountCents:15000},{months:12,amountCents:150000}]}}],house:{id:1,communityId:1,buildingNo:'1',roomNo:'101'},onCart:(_p,c)=>carts.push(c),vehicleClass:'住户车-1'};
 const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
 function render(){si=ei=ri=0;const tree=module.exports.CarRenewal(props);return nodes(tree).find(n=>n.type===Months).props}
 function commit(){const todo=pending;pending=[];for(const e of todo){effects[e.i]?.cleanup?.();effects[e.i]={deps:e.deps,cleanup:e.fn()}}}
 return{render,commit,requests,carts,props,unmount(){effects.forEach(e=>e?.cleanup?.())},quote:(months)=>({quantity:months,amountCents:months===12?150000:months*15000,startDate:'2027-01-01',endDate:'2027-12-31'})};
}
test('invalid manual draft clears the cart and cannot revive after late quote',async()=>{
 const h=make();h.render();h.commit();const old=h.requests.at(-1);
 assert.equal(typeof h.render().onValidityChange,'function');
 h.render().onValidityChange(false);assert.equal(h.carts.at(-1),null);
 old.resolve(h.quote(6));await flush();assert.equal(h.carts.at(-1),null);
 h.render();h.commit();assert.equal(h.requests.length,1,'invalid draft must not request old month');
 h.render().onValidityChange(true);h.render().onChange(17);h.render();h.commit();assert.equal(h.requests.at(-1).o.data.months,17);
});
test('same rule id with changed pricing requotes; wrong quantity is never chargeable',async()=>{
 const h=make();h.render();h.commit();h.requests.at(-1).resolve(h.quote(6));await flush();
 h.props.rules[0]={...h.props.rules[0],unitPriceCents:18000};h.render();h.commit();
 assert.equal(h.carts.at(-1),null);assert.equal(h.requests.length,2);
 h.requests.at(-1).resolve(h.quote(12));await flush();assert.equal(h.carts.at(-1),null);
});
test('vehicle/house change and unmount invalidate pending quotes and old cart',async()=>{
 const h=make();h.render();h.commit();const old=h.requests.at(-1);
 h.props.house={...h.props.house,id:2};h.render();h.commit();assert.equal(h.requests.at(-1).o.data.houseId,2);
 old.resolve(h.quote(6));await flush();assert.equal(h.carts.at(-1),null);
 const newer=h.requests.at(-1);h.unmount();newer.resolve(h.quote(6));await flush();assert.equal(h.carts.at(-1),null);
});
test('clicking the selected month again retries instead of leaving cart cleared forever',async()=>{
 const h=make();h.render();h.commit();h.requests[0].resolve(h.quote(6));await flush();
 h.render().onChange(6);h.render();h.commit();assert.equal(h.requests.length,2);
});
test('a rule restricted to another parking target is not used as generic fallback',()=>{
 const h=make();h.props.rules[0].config.parkingTargets=['local:other'];h.render();h.commit();assert.equal(h.requests.length,0);
});
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()};
test('configured zero quote remains chargeable',async()=>{
 const h=make();h.render();h.commit();h.requests.at(-1).resolve({...h.quote(6),amountCents:0});await flush();assert.equal(h.carts.at(-1).estimate.amountCents,0);
});
test('inconsistent system dates renew from the latest date rather than consuming paid validity',()=>{
 const h=make();h.props.car.lots[0].endDate='2027-01-31';h.props.car.lots.push({...h.props.car.lots[0],key:'b',endDate:'2027-06-30'});
 h.render();h.commit();assert.equal(h.requests.at(-1).o.data.currentEndDate,'2027-06-30');
});
test('month change clears chargeable cart immediately and ignores old success before effect cleanup',async()=>{
 const h=make();h.render();h.commit();h.requests[0].resolve(h.quote(6));await flush();assert.equal(h.carts.at(-1).months,6);
 h.render().onChange(11);h.render();h.commit();const old=h.requests.at(-1);
 h.render().onChange(12);assert.equal(h.carts.at(-1),null);
 old.resolve(h.quote(11));await flush();assert.equal(h.carts.at(-1),null,'old quote must not reactivate the prior month cart');
 h.render();h.commit();h.requests.at(-1).resolve(h.quote(12));await flush();assert.equal(h.carts.at(-1).months,12);assert.equal(h.carts.at(-1).estimate.amountCents,150000);
});
