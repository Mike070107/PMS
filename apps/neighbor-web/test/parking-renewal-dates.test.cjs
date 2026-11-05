const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),realDayjs=require('dayjs');
const root=path.resolve(__dirname,'../../..');
let today='2026-11-05';
function load(file){const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(code,{module,exports:module.exports,require(n){if(n==='@/lib/format')return{dayjs:v=>realDayjs(v===undefined?today:v)};if(n.startsWith('.'))return load(path.resolve(path.dirname(file),n+'.ts'));return{};}});return module.exports;}
const web=load(path.join(root,'apps/neighbor-web/src/lib/parking-ops.ts'));
const api=load(path.join(root,'apps/api/src/modules/business/business-execution.util.ts'));
test('browser date implementation exactly matches authoritative server helper',()=>{
 assert.equal(fs.readFileSync(path.join(root,'apps/neighbor-web/src/lib/parking-renewal-window.ts'),'utf8'),fs.readFileSync(path.join(root,'apps/api/src/modules/business/parking-renewal-window.ts'),'utf8'));
});
for(const [now,current,months,end] of [
 ['2026-11-01',null,1,'2026-11-30'],['2026-11-10',null,1,'2026-11-30'],['2026-11-11',null,1,'2026-12-31'],
 ['2026-11-05','2026-11-30',1,'2026-12-31'],['2026-11-30','2026-11-30',1,'2026-12-31'],
 ['2026-11-05','2027-01-31',1,'2027-02-28'],['2026-11-05','2028-01-31',1,'2028-02-29'],
 ['2026-11-05','2026-12-15',2,'2027-02-28'],['2026-12-11','2025-12-31',12,'2027-12-31'],
 ['2026-11-05','2026-11-30',60,'2031-11-30']]){
 test(`both real entry algorithms: ${now} / ${current} + ${months} -> ${end}`,()=>{today=now;assert.equal(web.renewalEndDate(current,months),end,'vehicle form');assert.equal(api.renewalWindow({today:now,currentEndDate:current,months}).endDate,end,'cashier server');});
}
