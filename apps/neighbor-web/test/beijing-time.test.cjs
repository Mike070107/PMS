const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const esbuild=require('esbuild');
const fs=require('node:fs');
test('今日清单实际recentClock把UTC登记时间显示为北京时间',()=>{
 const source=fs.readFileSync(path.join(root,'apps/neighbor-web/src/pages/Today.tsx'),'utf8');
 const match=source.match(/const recentClock = ([\s\S]*?)\n  };/);
 assert.ok(match,'实际页面时间格式化仍存在，不能用替身函数替代');
 const result=run('UTC',`const formatBeijingDateTime=time.formatBeijingDateTime; const recentClock=${match[1]}\n}; console.log(JSON.stringify(recentClock({recordedAt:'2026-11-14T06:58:00Z'})))`);
 assert.equal(result,'14:58');
});
const root=path.resolve(__dirname,'../../..');
test('后台时间显示不再依赖dayjs默认设备时区',()=>{
 const ts=require(path.join(root,'apps/api/node_modules/typescript'));const violations=[];
 for(const sub of ['apps/neighbor-web/src','apps/admin-web/src']){
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.tsx?$/.test(file)){
    const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    function visit(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='format'&&n.arguments.length===1&&ts.isStringLiteral(n.arguments[0])&&/H|mm|ss/.test(n.arguments[0].text))violations.push(path.relative(root,file)+': '+n.getText(ast));ts.forEachChild(n,visit)}visit(ast);
   }
  }}walk(path.join(root,sub));
 }
 assert.deepEqual(violations,[]);
});
test('员工收费历史/抄表/登录/签字钟点也固定北京时间',()=>{
 const ts=require(path.join(root,'apps/api/node_modules/typescript'));
 for(const [rel,name,expected] of [
  ['pages/apartment-cashier/apartment-cashier.ts','formatPaidAt','11/14 14:58'],
  ['utils/meter.ts','formatMeterTime','2026-11-14 14:58'],
  ['pages/web-login/web-login.ts','formatTime','11-14 14:58'],
  ['pages/maintenance-sign/maintenance-sign.ts','dateTimeText','2026-11-14 14:58'],
 ]){
  const source=fs.readFileSync(path.join(root,'apps/miniapp-staff/miniprogram',rel),'utf8');
  const ast=ts.createSourceFile(rel,source,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name);assert.ok(fn,name);
  const body=`import {parseDate} from './apps/miniapp-staff/miniprogram/pages/maintenance-sign/sheet-model.ts'; const formatBeijingDateTime=time.formatBeijingDateTime; ${fn.getText(ast).replace(/^export /,'')} console.log(JSON.stringify(${name}('2026-11-14T06:58:00.000Z')))`;
  const result=run('UTC',body);assert.ok(result.endsWith(expected),`${name}: ${result}`);
 }
});
test('跨日/偏移/无偏移旧时间/纯日期/空值统一且不改原值',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Asia/Tokyo']){
  const values=['2026-11-14T17:30:00Z','2026-11-13T22:58:00-08:00','2026-11-14 14:58:00','2026-11-14',null,'bad','2026-02-30T06:58:00Z'];
  const result=run(zone,`const v=${JSON.stringify(values)};const before=JSON.stringify(v);console.log(JSON.stringify({times:v.map(x=>time.formatBeijingDateTime(x)),dateClock:time.formatBeijingDateTime(v[3],'HH:mm'),short:time.formatDateShortCn(v[0]),unchanged:JSON.stringify(v)===before}))`);
  assert.deepEqual(result,{times:['2026-11-15 01:30','2026-11-14 14:58','2026-11-14 14:58','2026-11-14','','',''],dateClock:'',short:'11/15 01:30',unchanged:true},zone);
 }
});
test('停留自然日跨北京时间零点而非设备零点',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
  assert.equal(run(zone,`console.log(JSON.stringify(time.stayDays('2026-11-14T15:30:00Z',new Date('2026-11-14T16:30:00Z'))))`),1,zone);
 }
});
test('时限今天/明天按北京时间日期分类',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
  const body=`import {dueText} from './apps/neighbor-web/src/lib/format.ts';const R=Date;const fixed=R.parse('2026-11-14T15:30:00Z');globalThis.Date=class extends R{constructor(...args){super(...(args.length?args:[fixed]))}static now(){return fixed}};console.log(JSON.stringify(dueText('2026-11-14T16:30:00Z')))`;
  assert.equal(run(zone,body),'明天 00:30',zone);
 }
});
for(const [rel,name] of [['apps/neighbor-web/src/pages/Statistics.tsx','timeText'],['apps/admin-web/src/pages/ReportsPage.tsx','fmtDateTime']]){
 test(name+'必须保留原字符串的无offset和日期only语义',()=>{
  const ts=require(path.join(root,'apps/api/node_modules/typescript'));const text=fs.readFileSync(path.join(root,rel),'utf8');const ast=ts.createSourceFile(rel,text,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name);assert.ok(fn);
  for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
   const body=`import {dayjs} from './apps/neighbor-web/src/lib/format.ts';const formatBeijingDateTime=time.formatBeijingDateTime;${fn.getText(ast)}console.log(JSON.stringify(['2026-11-14 14:58:00','2026-11-14'].map(v=>${name}(v))))`;
   assert.deepEqual(run(zone,body),['2026-11-14 14:58','2026-11-14'],zone);
  }
 });
}
test('旧无offset时限的过期比较与未来显示都按北京时间',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
  const body=`import {dueText} from './apps/neighbor-web/src/lib/format.ts';const R=Date,fixed=R.parse('2026-11-14T10:00:00Z');globalThis.Date=class extends R{constructor(...args){super(...(args.length?args:[fixed]))}static now(){return fixed}};console.log(JSON.stringify(['2026-11-14 17:00:00','2026-11-17 14:58:00'].map(dueText)))`;
  assert.deepEqual(run(zone,body),['11-14 17:00 · 已超时','11-17 14:58'],zone);
 }
});
test('采购同一来源时间戳拆行的日期也取北京时间',()=>{
 const source=fs.readFileSync(path.join(root,'apps/neighbor-web/src/pages/Purchase.tsx'),'utf8');
 const match=source.match(/i\.sourceReportedAt \? <><div>\{([^{}]+)\}<\/div>/);assert.ok(match);
 for(const zone of ['UTC','America/Los_Angeles','Asia/Shanghai']){
  const body=`import {dayjs} from './apps/neighbor-web/src/lib/format.ts';const formatBeijingDateTime=time.formatBeijingDateTime;const i={sourceReportedAt:'2026-11-14T17:30:00Z'};console.log(JSON.stringify(${match[1]}))`;
  assert.equal(run(zone,body),'2026-11-15',zone);
 }
});
function run(zone,body){
 const {outputFiles}=esbuild.buildSync({stdin:{contents:`import * as time from './packages/shared-types/src/index.ts';\n${body}`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
 const result=spawnSync(process.execPath,[],{input:outputFiles[0].text,env:{...process.env,TZ:zone},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout);
}
test('UTC与带偏移时间共用同一个北京时间钟点格式化',()=>{
 const result=run('UTC',`console.log(JSON.stringify(typeof time.formatBeijingDateTime==='function' ? ['2026-11-14T06:58:00Z','2026-11-14T14:58:00+08:00'].map(v=>time.formatBeijingDateTime(v,'HH:mm')) : null))`);
 assert.deepEqual(result,['14:58','14:58']);
});
test('共用完整时间显示固定为北京时间而非运行设备时区',()=>{
 for(const zone of ['UTC','America/Los_Angeles','Asia/Tokyo','Asia/Shanghai']){
  const value=run(zone,`console.log(JSON.stringify(time.formatDateTimeCn('2026-11-14T06:58:00Z')))`);
  assert.equal(value,'2026/11/14 14:58 周六',zone);
 }
});
