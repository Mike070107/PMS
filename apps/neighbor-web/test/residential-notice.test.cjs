const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const ts=require('typescript');
const moduleUnderTest={exports:{}};
new Function('module','exports',ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../src/lib/residential-bills.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(moduleUnderTest,moduleUnderTest.exports);
const h=moduleUnderTest.exports;
const bill=(period,extra={})=>({id:period,feeCode:'WY',feeName:'物业费',period,amountCents:12345,...extra});
const notice=(bills,extra={})=>({houseKey:'house-a',address:'198弄1号101室',ownerName:'测试户',communityName:'枫桦景苑一期',amountCents:h.sumCents(bills.map(b=>b.amountCents)),bills,...extra});
const options={queriedAt:'2000-01-01',batchNo:'INTERNAL-BATCH',paper:'A5',printedAt:new Date('2026-12-31T16:30:00Z')};
const render=(bills,extra={})=>h.renderNoticeDocument([notice(bills,extra)],options);
const rows=html=>[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].flatMap(m=>[...m[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(r=>r[1]));

test('一个月一行：12 个账期就是 12 行，不合并、不折叠',()=>{
 const bills=Array.from({length:12},(_,i)=>bill('2026'+String(i+1).padStart(2,'0'))).reverse();
 const before=JSON.stringify(bills);
 const html=render(bills);
 assert.equal(rows(html).length,12);
 assert.match(rows(html)[0],/2026年1月/);
 assert.match(rows(html)[11],/2026年12月/);
 assert.equal((html.match(/data-notice-page=/g)||[]).length,1);
 assert.equal((html.match(/本户本次通知合计/g)||[]).length,1);
 assert.match(html,/本户本次通知合计 <b>¥1,481\.40/);
 assert.equal(JSON.stringify(bills),before);
});

test('缺月、跨年都按月分行',()=>{
 assert.equal(rows(render([bill('202601'),bill('202603')])).length,2);
 const cross=render([bill('202612'),bill('202701')]);
 assert.equal(rows(cross).length,2);
 assert.match(cross,/2026年12月/);assert.match(cross,/2027年1月/);
});

test('非法账期原样单行且安全转义',()=>{
 const periods=['202600','202613','',' 202601','2026-01','000001','<bad>'];
 const html=render(periods.map(p=>bill(p)));
 assert.equal(rows(html).length,periods.length);
 for(const p of periods)assert.ok(rows(html).some(r=>r.includes('<td>'+h.escapeHtml(p)+'</td>')),p);
 const bills=[bill('202601',{amountCents:Number.MAX_SAFE_INTEGER}),bill('202602',{amountCents:Number.MAX_SAFE_INTEGER})];
 assert.throws(()=>h.renderNoticeDocument([notice([],{bills,amountCents:0})],options),/安全/);
});

test('按我的设计：不印旧提示、印批次号、带责任声明',()=>{
 for(const name of ['枫桦一期','枫桦二期','枫桦景苑一期','枫桦景苑二期']){
  const html=render([bill('202601')],{communityName:name});
  assert.match(html,/您目前有以下物业费账单未缴纳，请及时缴纳，感谢您对我们工作的支持。/);
  assert.doesNotMatch(html,/如果您已缴费请通知我们再次核对。/);
  assert.match(html,/编号 INTERNAL-BATCH/);
  assert.match(html,/本单为欠费提醒，不作为收款凭证/);
  assert.match(html,/线上缴费已开通/);
  assert.match(html,/枫桦景苑物业管理处/);
  assert.match(html,/打印日期：2027-01-01/);
  assert.match(html,/<h1>物业服务费用缴费通知单<\/h1>/);
  assert.doesNotMatch(html,/MIS|逾期|核销|2000-01-01/);
 }
 assert.match(render([bill('202601')],{communityName:'真实小区<&>'}),/真实小区&lt;&amp;&gt;物业管理处/);
});

test('8 条展示行续页，A4 每纸两联，各户合计与落款各自保留',()=>{
 const a=notice(Array.from({length:13},(_,i)=>bill('bad-'+i))),b=notice([bill('202601')],{houseKey:'b',address:'第二户'});
 const html=h.renderNoticeDocument([a,b],{...options,paper:'A4'});
 assert.equal((html.match(/data-notice-page=/g)||[]).length,3);
 assert.equal((html.match(/class="paper"/g)||[]).length,2);
 assert.deepEqual([...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(m=>(m[1].match(/<tr>/g)||[]).length),[12,1,1]);
 assert.equal((html.match(/本户本次通知合计/g)||[]).length,2);
 assert.equal((html.match(/class="signature"/g)||[]).length,2);
 assert.match(html,/续页/);assert.match(html,/第二户/);
});

test('A5/A4 纸张零外边距、内部 9mm 留白',()=>{
 for(const paper of ['A5','A4']){
  const html=h.renderNoticeDocument([notice([bill('202601')])],{...options,paper});
  assert.match(html,/@page\s*\{[^}]*margin:0(?:[;}])/);
  assert.match(html,/\.paper\{[^}]*padding:9mm/);
  assert.match(html,new RegExp('width:'+(paper==='A5'?'148':'297')+'mm'));
  assert.match(html,new RegExp('(?:min-)?height:210mm'));
  assert.doesNotMatch(html,/display:\s*none/);
 }
});

// ── 二维码渲染：有图/转义/无图回退/单页 ──
const qrUrl='https://pay.example.com/qr.png?ref="><script>alert(1)</script>';
test('有二维码：渲染 img.qr 且 URL 经 HTML 转义，注入串不得落成标签，也不再渲染线上缴费 callout',()=>{
 const html=h.renderNoticeDocument([notice([bill('202601')])],{...options,template:{qrImageUrl:qrUrl}});
 assert.ok(html.includes('<img class="qr" src="'+h.escapeHtml(qrUrl)+'"'),'必须输出转义后的 img.qr 地址');
 assert.ok(!html.includes(qrUrl),'危险 URL 不能原样输出');
 assert.ok(!html.includes('<script>'),'注入串不能成为可执行标签');
 assert.match(html,/&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '引号/尖括号必须转义');
 assert.doesNotMatch(html,/线上缴费已开通/,'有图时不再渲染重复的线上缴费 callout');
 assert.doesNotMatch(html,/微信扫码进入缴费页/,'callout 正文同样不渲染');
});
test('无二维码（含旧快照无 noticeTemplate）：无 img，保留文字占位，并回退 DEFAULT 模板渲染线上缴费说明',()=>{
 // 旧批次快照没有 noticeTemplate 字段 → 打印端传 template undefined，renderNoticeDocument 合并 DEFAULT_NOTICE_TEMPLATE。
 const legacySnapshot={queriedAt:'2000-01-01',batchNo:'OLD-BATCH',notices:[]};
 const html=h.renderNoticeDocument([notice([bill('202601')])],{...options,template:legacySnapshot.noticeTemplate});
 assert.equal(h.DEFAULT_NOTICE_TEMPLATE.qrImageUrl,'','默认模板二维码为空');
 assert.doesNotMatch(html,/<img class="qr"/,'无图时不能输出 img');
 assert.match(html,/小程序缴费码/,'无图时保留文字占位');
 assert.match(html,/线上缴费已开通/,'回退 DEFAULT 模板后渲染线上缴费 callout');
 assert.match(html,/微信扫码进入缴费页/,'回退 DEFAULT 模板的说明文字');
});
test('12 期 + 二维码仍然只有 1 页：data-notice-page 1 个、无「续页」',()=>{
 const bills=Array.from({length:12},(_,i)=>bill('2026'+String(i+1).padStart(2,'0')));
 const html=h.renderNoticeDocument([notice(bills)],{...options,template:{qrImageUrl:'https://pay.example.com/qr.png'}});
 assert.equal(rows(html).length,12);
 assert.equal((html.match(/data-notice-page=/g)||[]).length,1,'12 期加二维码不能溢到第 2 页');
 assert.equal((html.match(/class="paper"/g)||[]).length,1);
 assert.doesNotMatch(html,/续页/);
 assert.match(html,/<img class="qr"/);
 assert.equal((html.match(/本户本次通知合计/g)||[]).length,1);
});
