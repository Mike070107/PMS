import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const req=createRequire(import.meta.url);
const ts=createRequire(new URL('../../api/package.json',import.meta.url))('typescript');
const XLSX=req('xlsx');
const source=readFileSync(new URL('../src/pages/FeesPage.tsx',import.meta.url),'utf8');
function expression(name){
 const ast=ts.createSourceFile('FeesPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let value;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)value=node.initializer.getText(ast);ts.forEachChild(node,visit);}
 visit(ast);assert.ok(value,`缺少正式导出处理器 ${name}`);
 return ts.transpileModule(`const action=${value}; exports.action=action;`,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
}
function exporter(){
 let workbook;const exports={};
 const helper=readFileSync(new URL('../src/lib/exportXlsx.ts',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(helper,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>name==='xlsx'?{...XLSX,writeFile:wb=>{workbook=XLSX.read(XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});}}:req(name)});
 return {...exports,book:()=>workbook};
}
const query={from:'2026-10-14',to:'2026-10-15'};
const message={success(){},error(error){throw new Error(error);},warning(error){throw new Error(error);}};
test('正式财务对账导出：动态方式列、负数、合计和Excel数值一致',async()=>{
 const helper=exporter();const cell={amountCents:-2000,chargedCents:0,refundedCents:2000,count:1};
 const rows=[{day:query.to,...cell,byMethod:{新渠道:cell}}];const totals={...cell,byMethod:{新渠道:cell}};const exports={};
 vm.runInNewContext(expression('exportRecon'),{exports,data:{},methods:['新渠道'],rows,totals,query,message,setExporting(){},methodLabel:x=>x,...helper});
 await exports.action();const book=helper.book();assert.ok(book);
 const cells=XLSX.utils.sheet_to_json(book.Sheets['按日对账'],{header:1});
 assert.equal(cells[0][1],'新渠道(元)');assert.equal(cells[1][1],-20);assert.equal(cells[1].at(-1),-20);assert.equal(cells[2].at(-1),-20);
 assert.equal(XLSX.utils.sheet_to_json(book.Sheets['按收款方式'])[0]['实收(元)'],-20);
});
test('正式收费报表导出：收费100−红冲100−退费20=净实收−20',async()=>{
 const helper=exporter();const exports={};
 const data={range:query,previousRange:query,totals:{netCents:-2000,chargedCents:10000,refundedCents:12000,receiptCount:3,houseCount:1,itemCount:3},previous:{},trend:[{bucket:query.to,amountCents:-2000,count:3}]};
 vm.runInNewContext(expression('exportReport'),{exports,data,query,message,setExporting(){},granularity:'day',methodRows:[{name:'新渠道',amountCents:-2000,count:3}],feeRows:[],communityRows:[],cashierRows:[],...helper});
 await exports.action();const rows=XLSX.utils.sheet_to_json(helper.book().Sheets['总览']);
 assert.equal(rows.find(r=>r['指标']==='实收合计(元)')['本期'],-20);assert.equal(rows.find(r=>r['指标']==='红冲及退费(元)')['本期'],120);
});
