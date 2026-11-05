import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as posting from './mis-posting.util';

const command = () => ({ownerId:'9007199254740993',officeCodes:['01'],receiptNo:'PMS:TEST-1',paidDate:'20261106',paymentMethodId:1,paymentMethod:'现金',collectorId:'OP01',collectorName:'测试收费员',bills:[{id:'9007199254740994',feeCode:'01',period:'202601',amountCents:12345}]});
const row = () => ({id:'9007199254740994',ownerId:'9007199254740993',officeCode:'01',propertyType:'01',feeCode:'01',period:'202601',amount:'123.4500',paidAt:null,refundedAt:null,receiptNo:null,paymentMethodId:null,collectorId:null,paymentMethod:null,collectorName:null,merchantOrder:null,tradeOrder:null,locked:false});

test('销账计划保留18位源库ID，精确核对分金额，不将未知/不匹配金额当成功',()=>{
 assert.equal(posting.planMisPosting(command(),[row()]).action,'post');
 assert.throws(()=>posting.planMisPosting(command(),[{...row(),amount:'123.4501'}]),/金额/);
 assert.throws(()=>posting.planMisPosting(command(),[{...row(),id:'9007199254740995'}]),/账单/);
});

test('销账只生成固定参数化语句，锁内读回，限制授权管理处与未归档行',()=>{
 const q=(posting as any).buildMisPostingSql(command());
 assert.match(q.select,/UPDLOCK,\s*HOLDLOCK/);
 assert.match(q.select,/ISNULL\(w\.SC,N'0'\)=N'0'/);
 assert.match(q.select,/CONVERT\(varchar\(30\),w\.ZJ_ID\)/);
 assert.match(q.select,/l\.管理处 IN \(@office0\)/);
 assert.match(q.update,/ZJ_SKRQ IS NULL/);
 assert.match(q.update,/收款方式ID=@methodId/);
 assert.match(q.update,/收款人ID=@collectorId/);
 assert.match(q.update,/收款人=@collectorName/);
 assert.match(q.update,/凭证号码=@receiptNo/);
 assert.equal(q.params.bill0,'9007199254740994');
 assert.equal(q.params.ownerId,'9007199254740993');
 assert.ok(!q.update.includes('9007199254740994'));
 assert.ok(!q.update.includes('测试收费员'));
});

const settled = () => ({...row(),paidAt:'20261106',receiptNo:'PMS:TEST-1',paymentMethodId:1,paymentMethod:'现金',collectorId:'OP01',collectorName:'测试收费员'});

test('同一凭证全字段回读一致才幂等；其他收款、部分销账和退款不补写',()=>{
 assert.equal(posting.planMisPosting(command(),[settled()]).action,'already_posted');
 for(const changed of [{receiptNo:'OTHER'},{collectorId:'OTHER'},{paymentMethodId:3},{paidAt:'20261105'},{refundedAt:'20261106'}]) {
  assert.throws(()=>posting.planMisPosting(command(),[{...settled(),...changed}]),/销账|退款/);
 }
 const cmd=command();cmd.bills.push({...cmd.bills[0],id:'2'});
 assert.throws(()=>posting.planMisPosting(cmd,[settled(),{...row(),id:'2'}]),/部分/);
});

test('跨户、跨管理处、不支持的房屋性质、重复ID和在途支付不得销账',()=>{
 for(const changed of [{ownerId:'2'},{officeCode:'04'},{propertyType:'02'},{merchantOrder:'WX-1'},{tradeOrder:'WX-2'},{locked:true},{receiptNo:'EXISTING'}]) {
  assert.throws(()=>posting.planMisPosting(command(),[{...row(),...changed}]));
 }
 const cmd=command();cmd.bills.push({...cmd.bills[0]});
 assert.throws(()=>posting.planMisPosting(cmd,[row(),row()]),/重复/);
});

test('明确的0元账单有效，空金额、负数、科学计数或非整分金额不得伪装0元',()=>{
 assert.equal(posting.planMisPosting({...command(),bills:[{...command().bills[0],amountCents:0}]},[{...row(),amount:'0.0000'}]).amountCents,0);
 for(const amount of ['',null,-1,'1e2','0.0001']) assert.throws(()=>posting.planMisPosting(command(),[{...row(),amount} as any]));
});

test('参数边界与无效日期被拒绝，不接受未明确映射的收款人',()=>{
 for(const patch of [{paidDate:'20260229'},{paidDate:'20261301'},{paidDate:'20790607'},{ownerId:9007199254740993},{officeCodes:[]},{officeCodes:['05']},{collectorId:''},{collectorName:' '},{paymentMethodId:0},{receiptNo:"PMS:x';DELETE"}]) {
  assert.throws(()=>posting.planMisPosting({...command(),...patch} as any,[row()]));
 }
});

test('默认关闭外部写入；开放后在同一SERIALIZABLE事务中核对、写入、回读再提交',async()=>{
 const events:string[]=[];let written=false;
 const driver={begin:async(level:string)=>{events.push(level);return {
   query:async(text:string,params:any)=>{
    assert.equal(params.ownerId,command().ownerId);
    if(text.startsWith('SELECT g.')){events.push('guard');return {recordset:[{officeCode:'01',department:'0-07-003',closedDate:'20260930',methodMatches:true,collectorMatches:true}]};}
    if(text.startsWith('SELECT CONVERT')){events.push(written?'readback':'locked-read');return {recordset:[written?settled():row()]};}
    if(text.startsWith('UPDATE')){events.push('write');written=true;return {rowsAffected:[1]};}
    throw Error('unexpected statement');
   },commit:async()=>{events.push('commit');},rollback:async()=>{events.push('rollback');}
 };}};
 await assert.rejects((posting as any).executeMisPosting(command(),driver),/未启用/);
 assert.deepEqual(events,[]);
 const r=await (posting as any).executeMisPosting(command(),driver,true);
 assert.equal(r.state,'synced');
 assert.deepEqual(events,['SERIALIZABLE','locked-read','guard','write','readback','commit']);
});

function transactionHarness(options:Record<string,any>={}) {
 const events:string[]=[];let written=false;
 const driver={begin:async()=>({
  query:async(text:string)=>{
   if(text.startsWith('SELECT g.')){events.push('guard');return {recordset:[{officeCode:'01',department:'0-07-003',closedDate:'20260930',methodMatches:true,collectorMatches:true,...options.guard}]};}
   if(text.startsWith('SELECT CONVERT')){events.push('read');return {recordset:[options.already?settled():written?(options.after||settled()):row()]};}
   events.push('write');written=true;if(options.writeError)throw Error('synthetic-secret-connection');return {rowsAffected:[options.affected??1]};
  },
  commit:async()=>{events.push('commit');if(options.commitError)throw Error('synthetic-secret-connection');},
  rollback:async()=>{events.push('rollback');if(options.rollbackError)throw Error('synthetic-secret-connection');},
 })};
 return {events,driver};
}

test('已封帐/收款人失效/方式映射失效/财务部门缺失：写入前拒绝并回滚',async()=>{
 for(const guard of [{closedDate:'20261106'},{collectorMatches:false},{methodMatches:false},{department:null}]) {
  const h=transactionHarness({guard});
  await assert.rejects((posting as any).executeMisPosting(command(),h.driver,true),(e:any)=>e.state==='refused');
  assert.ok(!h.events.includes('write'));assert.ok(h.events.includes('rollback'));
 }
});
test('影响行数或提交前回读不符：整笔回滚，不给已核验结果',async()=>{
 for(const options of [{affected:0},{after:{...settled(),collectorId:'OTHER'}}]) {
  const h=transactionHarness(options);
  await assert.rejects((posting as any).executeMisPosting(command(),h.driver,true));
  assert.ok(h.events.includes('rollback'));assert.ok(!h.events.includes('commit'));
 }
});
test('提交网络中断或写后无法确认回滚：标结果未知，不泄漏驱动错误',async()=>{
 for(const options of [{commitError:true},{writeError:true,rollbackError:true}]) {
  const h=transactionHarness(options);
  await assert.rejects((posting as any).executeMisPosting(command(),h.driver,true),(e:any)=>e.state==='unknown'&&!e.message.includes('synthetic-secret'));
  assert.equal(h.events.filter(e=>e==='write').length,1);
 }
});
test('read-only original-receipt inspection never posts an unpaid bill and recognizes the fully posted receipt',async()=>{
 for(const already of [false,true]){const h=transactionHarness({already});const result=await posting.inspectMisPosting(command(),h.driver);assert.equal(result.state,already?'synced':'unpaid');assert.ok(!h.events.includes('write'));}
});
test('未知结果后以原凭证重新查得全量一致：直接幂等完成，不发第二次UPDATE',async()=>{
 const h=transactionHarness({already:true});
 const r=await (posting as any).executeMisPosting(command(),h.driver,true);
 assert.equal(r.alreadyPosted,true);assert.ok(!h.events.includes('write'));
 assert.deepEqual(h.events,['read','commit']);
});
test('源库写错误且回滚明确成功：不称成功，错误信息不带SQL或连接配置',async()=>{
 const h=transactionHarness({writeError:true});
 await assert.rejects((posting as any).executeMisPosting(command(),h.driver,true),(e:any)=>e.state==='not_posted'&&!e.message.includes('synthetic-secret'));
 assert.ok(h.events.includes('rollback'));
});

test('mssql驱动开启XACT_ABORT并绑定Int/NVarChar，18位ID不转成Number',async()=>{
 const calls:any[]=[];
 const fakeSql={ISOLATION_LEVEL:{SERIALIZABLE:4},Int:'Int',NVarChar:(n:number)=>`NVarChar(${n})`,
  Transaction:class {constructor(pool:any){assert.equal(pool,'pool');}async begin(v:any){calls.push(['begin',v]);}async commit(){}async rollback(){}},
  Request:class {constructor(tx:any){}input(k:string,type:any,v:any){calls.push([k,type,v]);return this;}async query(s:string){calls.push(['query',s]);return {recordset:[]};}}
 };
 const d=(posting as any).createMssqlPostingDriver('pool',fakeSql);
 const t=await d.begin('SERIALIZABLE');await t.query('SELECT @id,@n',{id:'9007199254740993',n:10});
 assert.deepEqual(calls[0],['begin',4]);assert.deepEqual(calls[1],['query','SET XACT_ABORT ON;']);
 assert.ok(calls.some(c=>c[0]==='id'&&c[1]==='NVarChar(4000)'&&c[2]==='9007199254740993'));
 assert.ok(calls.some(c=>c[0]==='n'&&c[1]==='Int'));
});
