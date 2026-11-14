const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src');
let slots=[], cursor=0, effects=[];
const react={useState(init){const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return [slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v]},useEffect(fn){effects.push(fn)}};
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code, {module,exports:module.exports,require(name){
    if(name==='react')return react;
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
    if(name==='@/lib/parking-pricing')return load('lib/parking-pricing.ts');
    if(name.endsWith('.css'))return {};
    throw Error('unexpected import '+name);
  }});
  const exp=module.exports;
  if(file.endsWith('RenewalMonths.tsx')){const f=exp.default;exp.default=p=>{cursor=0;const tree=f(p);effects.splice(0).forEach(fn=>fn());return tree}}
  return exp;
}
function nodes(node) {return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
test.beforeEach(()=>{slots=[];cursor=0;effects=[]});
test('renewal month control offers 1/3/6/12 presets and single-month steps',()=>{
  const Picker=load('components/cashier/RenewalMonths.tsx').default;
  let value=11;
  const render=()=>nodes(Picker({value,onChange:n=>value=n}));
  const buttons=()=>render().filter(n=>n.type==='button');
  assert.deepEqual(buttons().filter(n=>n.props['data-month']).map(n=>n.props['data-month']),[1,2,3,6,12]);
  buttons().find(n=>n.props['aria-label']==='增加1个月').props.onClick();assert.equal(value,12);
  buttons().find(n=>n.props['aria-label']==='增加1个月').props.onClick();assert.equal(value,13);
  buttons().find(n=>n.props['aria-label']==='减少1个月').props.onClick();assert.equal(value,12);
  buttons().find(n=>n.props['data-month']===6).props.onClick();assert.equal(value,6);
});
test('renewal month control enforces bounds and disabled state',()=>{
  const Picker=load('components/cashier/RenewalMonths.tsx').default;
  for(const [value,disabled] of [[1,false],[60,false],[12,true]]) {
    const selected=[];const b=nodes(Picker({value,disabled,onChange:n=>selected.push(n)})).filter(n=>n.type==='button');
    assert.equal(b.find(n=>n.props['aria-label']==='减少1个月').props.disabled,disabled||value===1);
    assert.equal(b.find(n=>n.props['aria-label']==='增加1个月').props.disabled,disabled||value===60);
    if(disabled)assert.ok(b.every(n=>n.props.disabled));
  }
});
test('custom-date mode clears month preset selection without disabling the controls',()=>{
  const Picker=load('components/cashier/RenewalMonths.tsx').default;
  const selected=[];
  const buttons=nodes(Picker({value:12,active:false,onChange:n=>selected.push(n)})).filter(n=>n.type==='button');
  const presets=buttons.filter(n=>n.props['data-month']);
  assert.ok(presets.every(n=>n.props['aria-pressed']===false));
  assert.ok(presets.every(n=>!n.props.className.split(' ').includes('on')));
  presets.find(n=>n.props['data-month']===3).props.onClick();
  assert.deepEqual(selected,[3]);
});
test('manual month input permits empty draft but blocks invalid collection until repaired',()=>{
  const Picker=load('components/cashier/RenewalMonths.tsx').default;let value=6;const valid=[];
  const render=()=>nodes(Picker({value,onChange:n=>value=n,onValidityChange:v=>valid.push(v)}));
  const input=()=>render().find(n=>n.type==='input');
  assert.ok(input(),'custom month input is required');
  input().props.onChange({target:{value:''}});assert.equal(input().props.value,'');assert.equal(valid.at(-1),false);
  input().props.onBlur();assert.equal(input().props['aria-invalid'],true);assert.equal(value,6);
  for(const text of ['0','-1','1.5','1e1','abc','61']){input().props.onChange({target:{value:text}});input().props.onBlur();assert.equal(valid.at(-1),false,text);assert.equal(value,6,text)}
  input().props.onChange({target:{value:'17'}});assert.equal(value,17);assert.equal(valid.at(-1),true);
});
test('browser preview preserves exact table prices and uses only same-group monthly price for gaps',()=>{
  const {priceRule}=load('lib/parking-pricing.ts');
  const cfg={priceMode:'table',tiers:[{months:1,amountCents:15000},{months:3,amountCents:50000},{months:12,amountCents:150000}]};
  assert.equal(priceRule(3,999999,cfg).amountCents,50000);
  for(const m of [2,6,11,13,24]) assert.equal(priceRule(m,999999,cfg).amountCents,m*15000);
  assert.throws(()=>priceRule(11,999999,{...cfg,tiers:cfg.tiers.filter(t=>t.months!==1)}),/没有定/);
  assert.equal(priceRule(11,999999,{priceMode:'table',tiers:[{months:1,amountCents:0}]}).amountCents,0);
  assert.equal(priceRule(13,15000,{tiers:[{months:12,amountCents:150000}]}).amountCents,165000);
});
