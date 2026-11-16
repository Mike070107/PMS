const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const ts=createRequire(path.resolve(__dirname,'../../api/package.json'))('typescript');
const pageFile=path.resolve(__dirname,'../miniprogram/pages/order-detail/order-detail.ts');
function fixture({storage=new Map(),saveFailure=false,respond=async()=>({ok:true,actionNote:'AI擅改的意思',faultLocation:'AI位置',faultSymptom:'AI现象',materials:['角阀'],feeSuggestion:{feeCents:2000,ruleCode:'rule',basis:'规则'}})}={}){
 let config;const speech={};const calls=[];const toasts=[];const saves=[];
 const wx={getStorageSync:k=>storage.get(k)??'',setStorageSync:(k,v)=>storage.set(k,v),showToast:o=>toasts.push(o.title),switchTab:o=>o.complete?.()};
 function load(file){const exports={};const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(output,{exports,wx,console,setTimeout,clearTimeout,Page:c=>config=c,requirePlugin:()=>({getRecordRecognitionManager:()=>speech}),require:name=>{
   if(name==='@pms/api-client')return {ai:{completionSummary:async v=>{calls.push(v);return respond(v)}},repairs:{complete:async(id,data)=>{saves.push({id,data});if(saveFailure)throw Error('模拟提交失败')}}};
   if(name==='@pms/shared-types')return {WorkOrderStatus:{CREATED:'created',IN_PROGRESS:'in_progress'},REPAIR_TYPE_LABELS:{}};
   if(name==='@pms/miniapp-ui')return {statusLabel:{},createHoldToTalk:()=>({press(){},release(){},started(){},ended(){}})};
   if(name.endsWith('/completion-summary'))return load(path.resolve(path.dirname(file),name+'.ts'));
   if(name.endsWith('/unread'))return {askOrderSubscribe:async()=>false};
   if(name.endsWith('/tabbar'))return {rememberPoolMode(){},markPoolTabTapped(){}};
   if(name.endsWith('/guide'))return {guideHandlers:()=>({syncGuide(){}})};
   if(name.endsWith('/navigation'))return {swipeBackHandlers:()=>({})};
   return {};
  }});return exports;}
 load(pageFile);const page={...config,data:JSON.parse(JSON.stringify(config.data)),setData(patch,cb){Object.assign(this.data,patch);cb?.();}};
 page.data.id='901';page.bindSpeech();return {page,speech,calls,toasts,storage,saves};
}
const init=(f,tenant=7,user=9)=>f.page.initCompletionSummaryPreference({tenantId:tenant,id:user});
const toggle=(f,value)=>f.page.onAutoSummaryChange({detail:{value}});
const spoken=async(f,text)=>{f.speech.onStop({result:text});await new Promise(r=>setImmediate(r));};
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}};

if (require.main === module) {
test('正式Page语音：首次默认关闭，0 AI请求，原文追加且保留人工输入',async()=>{
 const f=fixture();f.page.data.actionNote='人工记录：没有换件。';
 await spoken(f,'紧了螺丝，没换角阀');assert.equal(f.calls.length,0);assert.equal(f.page.data.autoSummary,false);assert.equal(f.page.data.actionNote,'人工记录：没有换件。；紧了螺丝，没换角阀');assert.equal(f.page.data.feeYuan,'');
});
test('正式Page开启：AI只给候选，显式采用才改本次语音，不覆盖已有字段或加材料',async()=>{
 const f=fixture();init(f);toggle(f,true);f.page.data.actionNote='人工记录';f.page.data.faultLocation='人工位置';f.page.data.feeYuan='3';
 await spoken(f,'紧了螺丝');assert.equal(f.calls.length,1);assert.equal(f.page.data.actionNote,'人工记录；紧了螺丝');assert.equal(f.page.data.aiSummaryPreview,'AI擅改的意思');assert.equal(f.page.data.materialHints.length,0);
 f.page.onUseSummary();assert.equal(f.page.data.actionNote,'人工记录；AI擅改的意思');assert.equal(f.page.data.faultLocation,'人工位置');assert.equal(f.page.data.feeYuan,'3');assert.equal(f.page.data.materialRows.length,0);assert.equal(f.page.data.aiAssistTrace.sourceText,'紧了螺丝');
});
test('正式Page等待时编辑：迟到结果丢弃，人工文本不变',async()=>{
 const pending=deferred();const f=fixture({respond:()=>pending.promise});init(f);toggle(f,true);const request=f.page.summarize('原话');
 assert.equal(f.page.data.actionNote,'原话');f.page.onNote({detail:{value:'师傅手工纠正'}});pending.resolve({ok:true,actionNote:'迟到AI'});await request;
 assert.equal(f.page.data.actionNote,'师傅手工纠正');assert.equal(f.page.data.aiSummaryPreview,'');assert.equal(f.page.data.summarizing,false);
});
test('正式Page关闭中断：迟到结果不生效，重新开启不会复活旧请求',async()=>{
 const pending=deferred();const f=fixture({respond:()=>pending.promise});init(f);toggle(f,true);const request=f.page.summarize('没换件');toggle(f,false);toggle(f,true);
 pending.resolve({ok:true,actionNote:'更换了配件'});await request;assert.equal(f.page.data.actionNote,'没换件');assert.equal(f.page.data.aiSummaryPreview,'');
});
test('偏好：刷新/重进恢复，账号与租户隔离，缺身份不可写入共享key',()=>{
 const storage=new Map();const a=fixture({storage});init(a);toggle(a,true);const b=fixture({storage});init(b);assert.equal(b.page.data.autoSummary,true);init(b,7,10);assert.equal(b.page.data.autoSummary,false);init(b,8,9);assert.equal(b.page.data.autoSummary,false);init(b,7,9);assert.equal(b.page.data.autoSummary,true);
 const c=fixture({storage});toggle(c,true);assert.equal(c.page.data.autoSummary,false);assert.equal(storage.size,1);
});
test('失败保留原文/人工字段、重试不重复追加，成功候选可放弃',async()=>{
 let attempt=0;const f=fixture({respond:async()=>{if(++attempt===1)throw Error('模拟离线');return {ok:true,actionNote:'整理候选'}}});init(f);toggle(f,true);await f.page.summarize('未换件');assert.equal(f.page.data.actionNote,'未换件');assert.equal(f.page.data.summaryError,'整理失败，已保留原文');assert.equal(f.page.data.summarizing,false);
 await f.page.onRetrySummary();assert.equal(f.calls.length,2);assert.equal(f.page.data.actionNote,'未换件');assert.equal(f.page.data.aiSummaryPreview,'整理候选');f.page.onKeepOriginal();assert.equal(f.page.data.actionNote,'未换件');assert.equal(f.page.data.aiSummaryPreview,'');
});
test('候选等待采用后有人工变化：采用保护不覆盖、不改变收费与痕迹',async()=>{
 const f=fixture();init(f);toggle(f,true);await f.page.summarize('原文');f.page.data.actionNote='其他入口改过';f.page.onUseSummary();assert.equal(f.page.data.actionNote,'其他入口改过');assert.equal(f.page.data.aiAssistTrace,null);assert.equal(f.page.data.feeYuan,'');assert.equal(f.page.data.aiSummaryPreview,'');
});
test('失败ok:false、面板关闭和卸载均保留原文并使迟到请求失效',async()=>{
 const f=fixture({respond:async()=>({ok:false})});init(f);toggle(f,true);await f.page.summarize('无AI');assert.equal(f.page.data.actionNote,'无AI');assert.equal(f.page.data.summaryError,'整理失败，已保留原文');
 const pending=deferred();const g=fixture({respond:()=>pending.promise});init(g);toggle(g,true);const request=g.page.summarize('原文');g.page.onUnload();pending.resolve({ok:true,actionNote:'旧页面结果'});await request;assert.equal(g.page.data.aiSummaryPreview,'');assert.equal(g.page.data.actionNote,'原文');
});
test('面板关闭：在途响应失效，晚到识别保留原话但不调用AI',async()=>{
 const pending=deferred();const f=fixture({respond:()=>pending.promise});init(f);toggle(f,true);f.page.data.panel='complete';const request=f.page.summarize('关闭前原文');await f.page.onClosePanel();pending.resolve({ok:true,actionNote:'迟到结果'});await request;assert.equal(f.page.data.aiSummaryPreview,'');await spoken(f,'关闭后才识别');assert.equal(f.calls.length,1);assert.equal(f.page.data.actionNote,'关闭前原文；关闭后才识别');
});
test('存储不可用：安全默认OFF，写入失败本次仍可用且提示未保存',()=>{
 const storage={get(){throw Error('不可读')},set(){throw Error('不可写')}};const f=fixture({storage});init(f);assert.equal(f.page.data.autoSummary,false);toggle(f,true);assert.equal(f.page.data.autoSummary,true);assert.equal(f.toasts[0],'设置未能保存，仅本次生效');
});
test('正式Page提交：未采用候选不能进入保存payload，提交失败保留原文',async()=>{
 const f=fixture({saveFailure:true});init(f);toggle(f,true);await f.page.summarize('仅拧紧，未换件');await f.page.onComplete();assert.equal(f.saves[0].data.actionNote,'仅拧紧，未换件');assert.equal(f.saves[0].data.repairContent,'仅拧紧，未换件');assert.equal(f.saves[0].data.aiAssist,undefined);assert.equal(f.saves[0].data.feeCents,undefined);assert.equal(f.page.data.actionNote,'仅拧紧，未换件');assert.equal(f.page.data.errorMsg,'模拟提交失败');assert.equal(f.page.data.busy,false);
});
test('正式Page提交：采用后保存选中的说明和trace，关闭不追加任何AI结果',async()=>{
 const f=fixture();init(f);toggle(f,true);await f.page.summarize('原话');f.page.onUseSummary();await f.page.onComplete();assert.equal(f.saves[0].data.actionNote,'AI擅改的意思');assert.equal(f.saves[0].data.aiAssist.sourceText,'原话');assert.equal(f.saves[0].data.materials,undefined);assert.equal(f.page.data.panel,'');assert.ok(f.toasts.includes('已提交完工'));
});
test('打字不调用AI；关闭并重开面板后旧录音只保留原文',async()=>{
 const f=fixture();init(f);toggle(f,true);f.page.onNote({detail:{value:'手写原意'}});assert.equal(f.calls.length,0);f.page.onStartRecord({currentTarget:{dataset:{speechTarget:'summary'}}});f.page.data.recording=true;await f.page.onClosePanel();f.page.onOpenPanel({currentTarget:{dataset:{panel:'complete'}}});await spoken(f,'关闭前那段录音');assert.equal(f.calls.length,0);assert.equal(f.page.data.actionNote,'手写原意；关闭前那段录音');
});
test('连续两次语音：仅最新请求能展示候选，旧响应不能清掉新等待态',async()=>{
 const first=deferred(),second=deferred();let n=0;const f=fixture({respond:()=>++n===1?first.promise:second.promise});init(f);toggle(f,true);const a=f.page.summarize('第一句');const b=f.page.summarize('第二句');first.resolve({ok:true,actionNote:'旧候选'});await a;assert.equal(f.page.data.summarizing,true);assert.equal(f.page.data.aiSummaryPreview,'');second.resolve({ok:true,actionNote:'新候选'});await b;assert.equal(f.page.data.actionNote,'第一句；第二句');assert.equal(f.page.data.aiSummaryPreview,'新候选');f.page.onUseSummary();assert.equal(f.page.data.actionNote,'第一句；新候选');
});
}
module.exports={fixture,init,toggle};
