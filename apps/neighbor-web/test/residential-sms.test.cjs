const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const mod={exports:{}};new Function('module','exports',ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/lib/residential-bills.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);const h=mod.exports;
const bill=(period,amountCents=15230)=>({id:period,feeCode:'WY',feeName:'物业费',period,amountCents});
const notice=bills=>({houseKey:'01:1:2',address:'合成测试户',ownerName:'合成用户',amountCents:h.sumCents(bills.map(b=>b.amountCents)),bills});
test('短信按实际全年账期与金额生成用户指定温和文案',()=>{
 const n=notice(Array.from({length:12},(_,i)=>bill('2026'+String(i+1).padStart(2,'0'))));
 assert.equal(typeof h.noticeSmsText,'function','缺少统一短信草稿生成器');
 assert.equal(h.noticeSmsText(n),'住宅物业服务费用尚有2026年1-12月共计1,827.60元待缴纳。请联系物业管理处核对办理，感谢您对我们工作的支持');
 assert.doesNotMatch(h.noticeSmsText(n),/MIS|尚有.*待核对|提供凭据|已发送/);
});
test('短信按真实缺月和跨年分别列出，不把重复月份变为连续全年',()=>{
 const n=notice([bill('202603'),bill('202601'),bill('202601'),bill('202412')]);const before=JSON.stringify(n);
 assert.match(h.noticeSmsText(n),/2024年12月、2026年1月、2026年3月共计609\.20元/);
 assert.doesNotMatch(h.noticeSmsText(n),/1-3月|1-12月/);assert.equal(JSON.stringify(n),before);
});
test('未知账期明确待核对，不编造年份或月份',()=>{
 assert.match(h.noticeSmsText(notice([bill('bad')])),/账期待核对的账单共计/);
 assert.match(h.noticeSmsText(notice([bill('202601'),bill('bad')])),/2026年1月及部分账期待核对的账单共计/);
});
test('页面短信调用真实模板，通知预览和历史快照复用合并显示，住户原始明细不合并',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../src/pages/ResidentialBills.tsx'),'utf8');
 assert.match(source,/\{noticeSmsText\(n\)\}/);assert.doesNotMatch(source,/住宅服务费用尚有|如已缴请提供凭据核对/);
 assert.equal((source.match(/<BillTable bills=\{n\.bills\} compact\/>/g)||[]).length,2);
 assert.match(source,/<BillTable bills=\{bills\.data\?\.rows\|\|\[\]\}\/\>/);
});
