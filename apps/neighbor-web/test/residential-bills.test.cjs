const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const source=path.resolve(__dirname,'../src/lib/residential-bills.ts');
let helpers;function load(){assert.ok(fs.existsSync(source),'新版账单必须提供真实可测试的MIS通知与日期实现');if(!helpers){const ts=require('typescript');const out=path.resolve(__dirname,'../../../artifacts/residential-bills/web-helpers.cjs');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);helpers=require(out)}return helpers;}
test('正式账单入口只读取MIS，不再提供本地住宅收款按钮',()=>{const code=fs.readFileSync(path.resolve(__dirname,'../src/pages/Bills.tsx'),'utf8')+fs.readFileSync(path.resolve(__dirname,'../src/pages/ResidentialBills.tsx'),'utf8');assert.doesNotMatch(code,/\/fees\/bills\/pay/);assert.match(code,/收费总览/);assert.match(code,/\/fees\/mis\/residential/);});
test('中国时区本周从周一开始，本月不跨错误时区',()=>{const h=load();assert.deepEqual(h.trendRange('week',new Date('2026-11-01T17:00:00Z')),{from:'2026-11-02',to:'2026-11-02'});assert.deepEqual(h.trendRange('month',new Date('2026-11-01T17:00:00Z')),{from:'2026-11-01',to:'2026-11-02'});});
test('金额以安全整数分计算，零应收无收缴率',()=>{const h=load();assert.equal(h.collectionRate(0,0),null);assert.equal(h.collectionRate(10000,5000),50);assert.throws(()=>h.sumCents([Number.MAX_SAFE_INTEGER,1]),/安全/);assert.equal(h.sumCents([1,2,3]),6);});
test('A5通知HTML转义，不把收款二维码与停水电写进模板',()=>{const h=load();const notice={houseKey:'01:1:2',address:'<img src=x onerror=alert(1)>',ownerName:'测试&户',amountCents:1000,bills:[{id:'1',feeName:'物业<script>x</script>',period:'202601',amountCents:1000}]};const html=h.renderNoticeDocument([notice],{queriedAt:'2026-11-04T10:00:00Z',batchNo:'A1',paper:'A5'});assert.ok(!html.includes('<script>'));assert.match(html,/&lt;img/);assert.match(html,/@page\s*\{[^}]*A5/);assert.match(html,/10\.00/);assert.doesNotMatch(html,/扫码支付|停水|停电/);});
test('长账单分续页，金额合计只在最后一页，不截断明细',()=>{const h=load();const bills=Array.from({length:21},(_,i)=>({id:String(i),feeName:'物业管理费',period:'202601',amountCents:100}));const html=h.renderNoticeDocument([{houseKey:'01:1:2',address:'1号1室',ownerName:'测试户',amountCents:2100,bills}],{queriedAt:'2026-11-04',batchNo:'A2',paper:'A5'});assert.equal((html.match(/data-notice-page=/g)||[]).length,3);assert.equal((html.match(/本户本次通知合计/g)||[]).length,1);assert.equal((html.match(/物业管理费/g)||[]).length,21);});
test('A4双联是独立文档纸张规则，不污染全站',()=>{const h=load();const html=h.renderNoticeDocument([],{queriedAt:'2026-11-04',batchNo:'A3',paper:'A4'});assert.match(html,/A4 landscape/);assert.match(html,/grid-template-columns:repeat\(2/);});

// Execute the page's real hooks, JSX and manual async handlers in an isolated
// deterministic hook runner; expose a test port without replacing business code.
// This is not browser/React scheduler coverage.
function pageHarness(){
 const vm=require('node:vm'),ts=require('typescript');let cursor=0,dirty=false;const slots=[],effects=[],pending=[],requests=[],prints=[],notices=[];
 const session={user:{id:1},access:{scopeAll:true}};
 const react={useState(init){const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return [slots[i],v=>{const n=typeof v==='function'?v(slots[i]):v;if(n!==slots[i]){slots[i]=n;dirty=true}}]},useRef(init){const i=cursor++;return slots[i]??(slots[i]={current:init})},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){slots[i]=deps;effects.push(fn)}}};
 let code=fs.readFileSync(path.resolve(__dirname,'../src/pages/ResidentialBills.tsx'),'utf8');
 const start=code.indexOf(' const s=dash.data?.summary');assert.ok(start>0);
 code=code.slice(0,start)+' globalThis.__port={prepare,confirm,viewBatch,setCommunity,setPreview,setConfirmed,setHistoryPage,setTab,historyPage,preview,record,busy,error};\n'+code.slice(start);
 const module={exports:{}};const helpers={...load(),printNotices:async(...args)=>prints.push(args)};
 const sandbox={module,exports:module.exports,require(id){if(id==='react')return react;if(id==='react/jsx-runtime')return require(id);if(id==='@pms/api-client')return {request:o=>new Promise((resolve,reject)=>requests.push({o,resolve,reject}))};if(id==='@/lib/auth')return {useSession:()=>session};if(id==='@/lib/perm')return {can:()=>true};if(id==='@/lib/residential-bills')return helpers;return {__esModule:true,default:()=>null,Card:'Card',Empty:'Empty',ErrorNote:'ErrorNote',Sheet:'Sheet',toast:s=>notices.push(s)}},setTimeout:fn=>{pending.push(fn);return 1},clearTimeout(){},crypto:{randomUUID:()=> 'synthetic-id'},console};
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,sandbox);
 let port;function render(){let n=0;do{dirty=false;cursor=0;const ui=module.exports.default();port=sandbox.__port;port.ui=ui;while(effects.length)effects.shift()();assert.ok(++n<30)}while(dirty);return port}
 function aba(){port.setCommunity('B');render();port.setCommunity('');render()}
 async function data(response){const at=requests.length;while(pending.length)pending.shift()();for(const r of requests.slice(at))r.resolve(response(r.o));await Promise.resolve();await Promise.resolve();return render()}
 return {render,aba,session,requests,prints,notices,data};
}
const syntheticPreview={totalCents:0,billCount:0,notices:[],queriedAt:'2026-11-04',fingerprint:'synthetic',skipped:[]};
for(const action of ['prepare','confirm','viewBatch'])test(`真实页面${action}丢弃A→B→A旧结果且不结束新请求busy`,async()=>{
 const h=pageHarness();let p=h.render();if(action==='confirm'){p.setPreview(syntheticPreview);p.setConfirmed(true);p=h.render()}
 const call=()=>action==='prepare'?h.render().prepare('print'):action==='confirm'?h.render().confirm():h.render().viewBatch(1);
 const old=call();h.aba();p=h.render();
 if(action==='confirm'){p.setPreview(syntheticPreview);p.setConfirmed(true);h.render()}
 const fresh=call();h.requests[0].resolve(action==='prepare'?syntheticPreview:{id:1,snapshot:syntheticPreview});await old;p=h.render();
 assert.equal(p.busy,true,'过期finally不得结束新上下文请求');assert.equal(p.record,null);assert.equal(h.prints.length,0);assert.equal(h.notices.length,0);
 if(action==='prepare')assert.equal(p.preview,null,'旧预览不得打开弹窗');
 h.requests[1].resolve(action==='prepare'?syntheticPreview:{id:2,snapshot:syntheticPreview});await fresh;assert.equal(h.render().busy,false);
});

for(const action of ['prepare','confirm','viewBatch'])test(`真实页面${action}身份变化后旧异常不污染新错误或busy`,async()=>{
 const h=pageHarness();let p=h.render();if(action==='confirm'){p.setPreview(syntheticPreview);p.setConfirmed(true);p=h.render()}
 const old=action==='prepare'?p.prepare('sms'):action==='confirm'?p.confirm():p.viewBatch(1);
 h.session.user={id:2};h.render();h.requests[0].reject(new Error('旧身份错误'));await old;
 assert.equal(h.render().error,'');assert.equal(h.render().busy,false);
});
test('打印等待字体期间上下文失效不得继续弹出打印窗口',async()=>{
 const h=load();let valid=true,release;const fonts=new Promise(r=>release=r);let prints=0,removed=false;
 const oldDoc=global.document,oldWindow=global.window,oldTimeout=global.setTimeout;global.setTimeout=fn=>{queueMicrotask(fn);return 1};
 global.document={body:{appendChild(){}},createElement(){return {style:{},remove(){removed=true},contentDocument:{open(){},write(){},close(){},fonts:{ready:fonts}},contentWindow:{addEventListener(){},focus(){},print(){prints++}}}}};global.window={removeEventListener(){}};
 try{const p=h.printNotices([],{queriedAt:'2026-11-04',batchNo:'test',paper:'A5'},()=>valid);valid=false;release();await p;assert.equal(prints,0);assert.equal(removed,true)}finally{global.document=oldDoc;global.window=oldWindow;global.setTimeout=oldTimeout}
});

test('住宅历史范围及身份改变重置分页到第一页',()=>{
 const h=pageHarness();let p=h.render();p.setHistoryPage(3);p=h.render();assert.equal(p.historyPage,3);
 p.setCommunity('B');p=h.render();assert.equal(p.historyPage,1,'切换范围必须回第一页');
 p.setHistoryPage(4);h.render();h.session.user={id:2};assert.equal(h.render().historyPage,1,'切换身份必须回第一页');
});
function uiText(node){if(node==null||typeof node==='boolean')return '';if(typeof node==='string'||typeof node==='number')return String(node);if(Array.isArray(node))return node.map(uiText).join('');return uiText(node.props?.children)}
test('住宅历史空分页不能宣称根本没有通知批次',async()=>{
 const h=pageHarness();h.render();let p=await h.data(()=>({available:true,communities:[],feeItems:[]}));p.setTab('history');p.setHistoryPage(3);h.render();
 p=await h.data(o=>o.url==='/fees/mis/collections'?{rows:[],total:30}:{});
 const text=uiText(p.ui);assert.ok(!text.includes('尚无通知批次'),'总数非零只是本页为空');assert.match(text,/本页没有|本页无/);
});

for(const failed of [false,true])test('打印登记先于浏览器print，登记失败不打印：'+failed,async()=>{const h=load(),events=[];let removed=false;const oldDoc=global.document,oldWindow=global.window,oldTimeout=global.setTimeout;global.setTimeout=fn=>{queueMicrotask(fn);return 1};global.document={body:{appendChild(){}},createElement(){return {style:{},remove(){removed=true},contentDocument:{open(){},write(){},close(){},fonts:{ready:Promise.resolve()},querySelectorAll(){return [{},{}]}},contentWindow:{addEventListener(){},focus(){},print(){events.push('print')}}}}};global.window={removeEventListener(){}};try{const run=h.printNotices([],{queriedAt:'2026-11-04',batchNo:'test',paper:'A5'},()=>true,async count=>{assert.equal(count,2);events.push('registered');if(failed)throw Error('fixture registration unavailable')});if(failed){await assert.rejects(run,/registration unavailable/);assert.deepEqual(events,['registered']);assert.equal(removed,true)}else{await run;assert.deepEqual(events,['registered','print'])}}finally{global.document=oldDoc;global.window=oldWindow;global.setTimeout=oldTimeout}});
