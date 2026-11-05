const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const dayjs = require('dayjs');
const root = path.resolve(__dirname, '../src');
const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...[n.props?.children].flat(Infinity).flatMap(nodes)];
const flush = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };
function make(rates = {owner:{1:180},tenant:{1:260}}) {
  const slots=[], effects=[], refs=[], calls=[]; let si=0,ei=0,ri=0,pending=[];
  const react={useState(v){const i=si++;if(!(i in slots))slots[i]=typeof v==='function'?v():v;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useRef(v){const i=ri++;return refs[i]??(refs[i]={current:v})},useMemo:f=>f(),useEffect(fn,deps){const i=ei++;if(!effects[i]||deps.some((v,j)=>v!==effects[i].deps[j]))pending.push({i,fn,deps})}};
  const api={parkingFeeRates:async()=>rates,createParkingOperation:async data=>{calls.push(data);return{id:1,status:'completed'}},renewDeliyunVehicle:async d=>{calls.push(d)}};
  function Months(){}
  function load(file){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require(n){if(n.startsWith('.'))return load(path.relative(root,path.resolve(path.dirname(path.join(root,file)),n+'.ts')));if(n==='react')return react;if(n==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(n==='@pms/api-client')return{accessCardIssuance:api};if(n==='@/lib/format')return{dayjs,money:n=>'¥'+n};if(n==='@/lib/parking-fields')return load('lib/parking-fields.ts');if(n==='@/lib/parking-ops')return load('lib/parking-ops.ts');if(n.endsWith('/RenewalMonths'))return{default:Months};return{Sheet:()=>null,toast:()=>{},default:()=>null}}});return module.exports}
  const Component=load('components/vehicle-ops/RenewSheet.tsx').default;
  const props={plate:'SYNTHETIC',rows:[{database:'parking1',fields:{P_id:1,P_plate:'SYNTHETIC',Car_Brand:'住户车',P_enddate:'2027-01-31'}}],cloud:null,onClose(){},onDone(){}};
  function render(){si=ei=ri=0;const ns=nodes(Component(props));const todo=pending;pending=[];for(const e of todo){effects[e.i]?.cleanup?.();effects[e.i]={deps:e.deps,cleanup:e.fn()}}return ns}
  return{render,props,calls,months:()=>render().find(n=>n.type===Months)?.props,button:()=>render().find(n=>n.type==='button'&&n.props.className==='btn p'),amount:()=>render().find(n=>n.type==='input'&&n.props.inputMode==='decimal')};
}
test('vehicle renewal uses the common 1-60 month control and does not turn a missing tier into free renewal',async()=>{
  const h=make();h.render();await flush();assert.ok(h.months(),'shared control required');
  h.months().onChange(17);assert.equal(h.button().props.disabled,true);
  h.amount().props.onChange({target:{value:'0'}});assert.equal(h.button().props.disabled,false,'explicit manual zero is allowed');
  await h.button().props.onClick();await flush();assert.equal(h.calls[0].payload.amount,0);assert.equal(h.calls[0].payload.months,17);
});
test('selected civil-defense renewal starts from the latest authorized system date',async()=>{
 const h=make();h.props.cloud={id:9,civilDefenseAuthorized:true,endDate:'2028-01-31'};h.render();await flush();
 await h.button().props.onClick();await flush();assert.equal(h.calls[0]?.payload.endDate,'2028-02-29');
});
test('rapid repeated submit does not renew or charge twice',async()=>{
 const h=make();h.render();await flush();const b=h.button();b.props.onClick();b.props.onClick();await flush();assert.equal(h.calls.length,1);
});
test('invalid months and amount text block submission, and switching plate clears a manual zero',async()=>{
 const h=make();h.render();await flush();h.months().onValidityChange(false);assert.equal(h.button().props.disabled,true);
 h.months().onChange(17);for(const value of ['','-1','1e2','1.234','abc']){h.amount().props.onChange({target:{value}});assert.equal(h.button().props.disabled,true,value)}
 h.amount().props.onChange({target:{value:'0'}});assert.equal(h.button().props.disabled,false);
 h.props.plate='OTHER';h.props.rows=[{...h.props.rows[0],fields:{...h.props.rows[0].fields,P_plate:'OTHER'}}];h.render();assert.equal(h.amount().props.value,'');assert.equal(h.months().value,1);
});
test('configured zero and family zero remain valid renewals',async()=>{
  for(const family of [false,true]){const h=make({owner:{1:0},tenant:{1:0}});if(family)h.props.rows[0].fields.Car_Brand='亲情车';h.render();await flush();assert.equal(h.button().props.disabled,false);await h.button().props.onClick();await flush();assert.equal(h.calls[0].payload.amount,0)}
});
