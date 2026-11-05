const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),dayjs=require('dayjs');
const root=path.resolve(__dirname,'../src');
function picker(props){const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(path.join(root,'components/DateInput.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require(n){if(n==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};if(n==='antd')return{DatePicker:'DatePicker'};if(n==='dayjs')return dayjs;if(n.endsWith('.css')||n.includes('locale'))return{};throw Error(n)}});return module.exports.default(props).props;
}
test('date input reuses AntD and preserves date strings, clear and original field identity',()=>{
 const changes=[];const p=picker({type:'date',value:'2026-11-05',name:'effectiveFrom',id:'from',onChange:e=>changes.push([e.target.value,e.target.name,e.target.id])});
 assert.equal(p.value.format('YYYY-MM-DD'),'2026-11-05');assert.equal(p.format,'YYYY-MM-DD');
 p.onChange(dayjs('2026-11-10'));p.onChange(null);assert.deepEqual(changes,[['2026-11-10','effectiveFrom','from'],['','effectiveFrom','from']]);
});
test('month precision, empty values, disabled state and min/max survive migration',()=>{
 const p=picker({type:'month',value:'2026-11',min:'2026-10',max:'2026-12',disabled:true});
 assert.equal(p.picker,'month');assert.equal(p.format,'YYYY-MM');assert.equal(p.disabled,true);
 assert.equal(p.disabledDate(dayjs('2026-09-30')),true);assert.equal(p.disabledDate(dayjs('2026-10-01')),false);assert.equal(p.disabledDate(dayjs('2027-01-01')),true);
 assert.equal(picker({value:''}).value,null);
});
test('required/readOnly fields do not gain clear or edit behavior',()=>{
 const p=picker({value:'2026-11-05',required:true,readOnly:true});assert.equal(p.allowClear,false);assert.equal(p.inputReadOnly,true);
});
test('date-time returns original local timestamp without timezone conversion',()=>{
 const changes=[];const p=picker({type:'datetime-local',value:'2026-11-05T13:20',onChange:e=>changes.push(e.target.value)});assert.ok(p.showTime);p.onChange(dayjs('2026-11-06T14:30'));assert.deepEqual(changes,['2026-11-06T14:30']);
});
test('all native calendar fields use the shared component',()=>{
 const files=['pages/ParkingSpaces.tsx','pages/Reports.tsx','pages/ResidentialBills.tsx','components/cashier/ParkingTab.tsx','components/settings/feeTemplates.tsx','components/vehicle-ops/RenewSheet.tsx'];
 for(const file of files){const s=fs.readFileSync(path.join(root,file),'utf8');assert.ok(s.includes("import DateInput from '@/components/DateInput'"),file);assert.doesNotMatch(s,/<input\b[^>]*type=["'](?:date|month|datetime-local)["']/m,file)}
});
