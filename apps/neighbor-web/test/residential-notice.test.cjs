const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const moduleUnderTest={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/lib/residential-bills.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(moduleUnderTest,moduleUnderTest.exports);
const h=moduleUnderTest.exports;
const bill=(period,extra={})=>({id:period,feeCode:'WY',feeName:'物业费',period,amountCents:12345,...extra});
const notice=(bills,extra={})=>({houseKey:'house-a',address:'198弄1号101室',ownerName:'测试户',communityName:'枫桦景苑一期',amountCents:h.sumCents(bills.map(b=>b.amountCents)),bills,...extra});
const options={queriedAt:'2000-01-01',batchNo:'INTERNAL-BATCH',paper:'A5',printedAt:new Date('2026-12-31T16:30:00Z')};
const render=(bills,extra={})=>h.renderNoticeDocument([notice(bills,extra)],options);
const rows=html=>[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap(m=>[...m[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r=>r[1]));
test('年度同费同月金额先合并再分页，原始账单及全户总额不变',()=>{
 const bills=Array.from({length:12},(_,i)=>bill('2026'+String(i+1).padStart(2,'0'))).reverse();
 const before=JSON.stringify(bills);bills.forEach(Object.freeze);Object.freeze(bills);
 const html=render(bills);
 assert.equal(rows(html).length,1);assert.match(html,/2026年1—12月/);
 assert.equal((html.match(/data-notice-page=/g)||[]).length,1);
 assert.match(rows(html)[0],/1,481\.40/);assert.match(html,/本户本次通知合计 <b>¥1,481\.40/);
 assert.equal(JSON.stringify(bills),before);
});
test('缺月、不同代码/名称/月额分行，重复月份不去重漏钱，跨年写清两年份',()=>{
 assert.equal(rows(render([bill('202601'),bill('202603')])).length,2);
 for(const extra of [{feeCode:'OTHER'},{feeName:'其他物业费'},{amountCents:12346}])assert.equal(rows(render([bill('202601'),bill('202602',extra)])).length,2);
 const duplicate=render([bill('202601'),bill('202601'),bill('202602')]);
 assert.equal(rows(duplicate).length,3);assert.match(duplicate,/¥370\.35/);
 assert.match(render([bill('202612'),bill('202701')]),/2026年12月—2027年1月/);
});
test('非法及空账期原文单行且安全转义，金额合并仍做安全整数校验',()=>{
 const periods=['202600','202613','',' 202601','2026-01','000001','<bad>'];
 const html=render(periods.map(p=>bill(p)));
 assert.equal(rows(html).length,periods.length);
 for(const p of periods)assert.ok(rows(html).some(r=>r.includes('<td>'+h.escapeHtml(p)+'</td>')),p);
 const bills=[bill('202601',{amountCents:Number.MAX_SAFE_INTEGER}),bill('202602',{amountCents:Number.MAX_SAFE_INTEGER})];
 assert.throws(()=>h.renderNoticeDocument([notice([],{bills,amountCents:0})],options),/安全/);
});
test('正文和落款按要求且打印日期取北京时间，批号及旧提示不打印',()=>{
 for(const name of ['枫桦一期','枫桦二期','枫桦景苑一期','枫桦景苑二期']){
  const html=render([bill('202601')],{communityName:name});
  assert.match(html,/您目前有以下物业费账单未缴纳，请及时缴纳，感谢您对我们工作的支持。/);
  assert.match(html,/如果您已缴费请通知我们再次核对。/);
  assert.match(html,/枫桦景苑物业管理处/);assert.match(html,/打印日期：2027-01-01/);
  assert.doesNotMatch(html,/MIS|携带凭据|逾期|本单不作为收款凭证|核销|INTERNAL-BATCH|编号|费用核对通知|2000-01-01/);
  assert.match(html,/<h1>物业服务费用缴费通知单<\/h1>/);
 }
 assert.match(render([bill('202601')],{communityName:'真实小区<&>'}),/真实小区&lt;&amp;&gt;物业管理处/);
});
test('8条展示行续页且跨户不合并，A4每纸两联且保留各户合计落款',()=>{
 const a=notice(Array.from({length:9},(_,i)=>bill('bad-'+i))),b=notice([bill('202601')],{houseKey:'b',address:'第二户'});
 const html=h.renderNoticeDocument([a,b],{...options,paper:'A4'});
 assert.equal((html.match(/data-notice-page=/g)||[]).length,3);
 assert.equal((html.match(/class="paper"/g)||[]).length,2);
 assert.deepEqual([...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(m=>(m[1].match(/<tr>/g)||[]).length),[8,1,1]);
 assert.equal((html.match(/本户本次通知合计/g)||[]).length,2);
 assert.equal((html.match(/class="signature"/g)||[]).length,2);
 assert.match(html,/续页/);assert.match(html,/第二户/);
});
test('A5/A4纸张零外边距，内部9mm留白而非隐藏正文落款',()=>{
 for(const paper of ['A5','A4']){
  const html=h.renderNoticeDocument([notice([bill('202601')])],{...options,paper});
  assert.match(html,/@page\s*\{[^}]*margin:0(?:[;}])/);
  assert.match(html,/\.paper\{[^}]*padding:9mm/);
  assert.match(html,new RegExp('width:'+(paper==='A5'?'148':'297')+'mm'));
  assert.match(html,new RegExp('(?:min-)?height:210mm'));
  assert.doesNotMatch(html,/display:\s*none/);
 }
});
