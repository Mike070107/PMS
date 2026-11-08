import test from 'node:test';
import assert from 'node:assert/strict';
import * as query from './mis-fees.query';
import { MisFeesService } from './mis-fees.service';
const report = (q:any={}, offices=['01']) => {
 const build=(query as any).buildMisResidentialQuery;
 assert.equal(typeof build,'function','住宅报表应提供MIS服务端全量聚合，而不是本地当前页小计');
 return build(q,offices);
};
test('缺失access必须拒绝，不得按不限范围查MIS',async()=>{
 const old=process.env.MIS_FEES_TENANT_ID;process.env.MIS_FEES_TENANT_ID='1';
 try {const s:any=new MisFeesService({find:async()=>[{id:1,name:'枫桦景苑一期'}]} as any,{} as any);let reads=0;s.read=async()=>{reads++;return {recordsets:[[],[]]}};
 await assert.rejects(s.list({},{id:1,tenantId:1} as any,undefined),/范围|授权/);assert.equal(reads,0);
 }finally{if(old===undefined)delete process.env.MIS_FEES_TENANT_ID;else process.env.MIS_FEES_TENANT_ID=old;}
});
test('概览按MIS全量聚合，忽略明细unpaid状态与分页',()=>{
 const r=report({view:'dashboard',status:'unpaid',periodFrom:'202601',periodTo:'202612',page:99});
 assert.match(r.sql,/GROUP BY/);assert.match(r.sql,/AS paidAmount/);assert.doesNotMatch(r.sql,/BETWEEN @firstRow/);assert.doesNotMatch(r.sql,/WHERE[^;]*w\.ZJ_SKRQ IS NULL/);assert.equal(r.params.periodFrom,'202601');
});
test('服务端范围与搜索参数化，注入文本不进SQL',()=>{
 const attack="%' OR 1=1--";const r=report({q:attack,view:'households',status:'unpaid'},['02','03']);
 assert.equal(r.params.office0,'02');assert.equal(r.params.office1,'03');assert.ok(!r.sql.includes(attack));assert.match(r.sql,/@search/);assert.throws(()=>report({},['05']),/范围/);
});
test('按户分页基于源room和责任人主键，不以姓名MAX拼联系人',()=>{
 const r=report({view:'households',page:2,pageSize:20,status:'unpaid'});
 assert.match(r.sql,/s\.S_ID/);assert.match(r.sql,/z\.ZH_ID/);assert.match(r.sql,/ROW_NUMBER/);assert.equal(r.params.firstRow,21);assert.equal(r.params.lastRow,40);assert.doesNotMatch(r.sql,/MAX\(z\.姓名\)/);assert.doesNotMatch(r.sql,/OFFSET|STRING_AGG|JSON_AGG/);
});
test('收款趋势不被账期截断，退款以退款日负值计入',()=>{
 const r=report({view:'trend',periodFrom:'202601',periodTo:'202612',paidFrom:'2026-11-01',paidTo:'2026-11-04'});
 assert.match(r.sql,/UNION ALL/);assert.match(r.sql,/ZJ_TKRQ/);assert.match(r.sql,/-w\.ZJ_JE/);assert.ok(!('periodFrom' in r.params));assert.equal(r.params.paidFrom,'2026-11-01');
});
test('禁止无日期无限趋势，非法分类和越界批量',()=>{
 assert.throws(()=>report({view:'trend'}),/日期/);assert.throws(()=>report({category:'bogus'}),/分类/);assert.throws(()=>report({view:'detail',houseKeys:['01:1:2','02:3:4']}),/范围/);assert.throws(()=>report({view:'detail',houseKeys:Array(201).fill('01:1:2')}),/200/);
});
test('住宅查询服务提供分类总览、按户及趋势，不回落本地账簿',async()=>{
 const old=process.env.MIS_FEES_TENANT_ID;process.env.MIS_FEES_TENANT_ID='1';
 try{const s:any=new MisFeesService({find:async()=>[{id:1,name:'枫桦景苑一期'}]} as any,{} as any);assert.equal(typeof s.residential,'function','必须提供真实MIS报表服务');let reads=0;s.read=async(sql:string)=>{reads++;assert.match(sql,/WYZJ/);return {recordsets:[[{total:'2',receivableAmount:'128.07',paidAmount:'100',unpaidAmount:'28.07',unpaidHouses:1}],[]]}};const r=await s.residential({view:'dashboard'},{tenantId:1,id:1},{scopeAll:true});assert.equal(r.summary.receivableCents,12807);assert.equal(r.summary.paidCents,10000);assert.equal(r.sourceLabel,'一通MIS');assert.equal(reads,1);await assert.rejects(s.residential({communityId:9},{tenantId:1,id:1},{scopeAll:true}),/范围/);
 }finally{if(old===undefined)delete process.env.MIS_FEES_TENANT_ID;else process.env.MIS_FEES_TENANT_ID=old;}
});

test('催缴先读最新MIS，已缴对象不出单，预览后金额变化拒绝生成',async()=>{
 const old=process.env.MIS_FEES_TENANT_ID;process.env.MIS_FEES_TENANT_ID='1';
 try{const repo:any={manager:{getRepository:()=>({find:async()=>[]})},findOne:async()=>null,create:(v:any)=>v,save:async(v:any)=>({...v,id:1})};const s:any=new (MisFeesService as any)({find:async()=>[{id:1,name:'枫桦景苑一期'}]}, {},repo);assert.equal(typeof s.previewCollection,'function','须复核真实MIS余额后才能出催缴单');let amount='10.00';s.read=async()=>({recordsets:[[{houseKey:'01:1:2',id:'11',officeCode:'01',address:'198弄1号2室',ownerName:'测试户',phone:'13800000000',period:'202601',feeCode:'1',feeName:'物业费',amount,updatedAt:'2026-11-04'}]]});const user={tenantId:1,id:7},access={scopeAll:true},dto:any={filter:{},selection:'keys',houseKeys:['01:1:2','01:3:4'],purpose:'print'};const p=await s.previewCollection(dto,user,access);assert.equal(p.notices.length,1);assert.deepEqual(p.skipped,['01:3:4']);assert.equal(p.totalCents,1000);assert.ok(!JSON.stringify(p).includes('13800000000'));amount='11.00';await assert.rejects(s.createCollection({...dto,fingerprint:p.fingerprint,idempotencyKey:'b9fc826a-4b10-4c01-a3b5-589be38d4f3a',confirmed:true},user,access),/变化|重新/);
 }finally{if(old===undefined)delete process.env.MIS_FEES_TENANT_ID;else process.env.MIS_FEES_TENANT_ID=old;}
});

test('已缴住户展开必须读取已缴明细而非待缴明细',()=>{const r=report({view:'detail',status:'paid',houseKeys:['01:1:2']});assert.match(r.sql,/ZJ_SKRQ IS NOT NULL/);assert.doesNotMatch(r.sql,/ZJ_SKRQ IS NULL/)});
test('责任对象keys不能改变office范围，明细只取正数未缴',()=>{
 const r=report({view:'detail',houseKeys:['01:123:456']});
 assert.equal(r.params.room0,'123');assert.equal(r.params.owner0,'456');assert.match(r.sql,/ZJ_SKRQ IS NULL/);assert.match(r.sql,/ZJ_TKRQ IS NULL/);assert.match(r.sql,/ZJ_JE>0/);
});

test('住宅DTO真实ValidationPipe拒绝退款及调整状态，旧账单DTO语义保持',async()=>{
 const {ValidationPipe}=require('@nestjs/common');const {MisResidentialQueryDto,MisFeesQueryDto,MisCollectionPreviewDto}=require('./mis-fees.dto');const pipe=new ValidationPipe({transform:true,whitelist:true});
 for(const status of ['refunded','adjustment','bogus']){
  await assert.rejects(pipe.transform({status},{type:'query',metatype:MisResidentialQueryDto}),/Bad Request/);
  await assert.rejects(pipe.transform({filter:{status},selection:'all',purpose:'print'},{type:'body',metatype:MisCollectionPreviewDto}),/Bad Request/);
 }
 for(const status of ['paid','unpaid'])assert.equal((await pipe.transform({status},{type:'query',metatype:MisResidentialQueryDto})).status,status);
 for(const status of ['refunded','adjustment'])assert.equal((await pipe.transform({status},{type:'query',metatype:MisFeesQueryDto})).status,status);
});
test('住宅query builder全部视图明确拒绝paid/unpaid之外状态，不静默当作待缴',()=>{
 for(const view of ['dashboard','households','trend','detail'])for(const status of ['refunded','adjustment','bogus',''])assert.throws(()=>report({view,status,houseKeys:['01:1:2'],paidFrom:'2026-11-01',paidTo:'2026-11-04'}),/状态/);
 for(const status of ['paid','unpaid'])assert.match(report({view:'households',status}).sql,/WYZJ/);
});

test('住户清单排序：address/amount 与方向进入 SQL、非法值 400、其他视图与内部扫描不受影响',async()=>{
 const amountDesc=report({view:'households',status:'unpaid',sort:'amount',dir:'desc'});
 assert.match(amountDesc.sql,/ROW_NUMBER\(\) OVER\(ORDER BY SUM\(w\.ZJ_JE\) DESC,/,'金额降序必须进 ROW_NUMBER');
 assert.match(amountDesc.sql,/z\.ZH_ID ASC\)/,'金额同额用地址唯一键兜底，保证翻页稳定');
 const amountAsc=report({view:'households',status:'unpaid',sort:'amount',dir:'asc'});
 assert.match(amountAsc.sql,/SUM\(w\.ZJ_JE\) ASC,/);
 const addressDesc=report({view:'households',status:'unpaid',sort:'address',dir:'desc'});
 assert.match(addressDesc.sql,/ORDER BY l\.管理处 DESC,/,'地址降序');
 assert.match(addressDesc.sql,/z\.ZH_ID DESC\)/,'地址排序末尾仍以 houseKey 组成键兜底');
 assert.match(report({view:'households',status:'unpaid'}).sql,/ORDER BY l\.管理处 ASC,/,'默认地址升序');
 // 非法 sort/dir 在服务层就是 BadRequest（HTTP 400），DTO 同样拦
 assert.throws(()=>report({view:'households',sort:'bogus' as any}),/排序/);
 assert.throws(()=>report({view:'households',dir:'up' as any}),/排序/);
 const {ValidationPipe}=require('@nestjs/common');const {MisResidentialQueryDto}=require('./mis-fees.dto');
 const pipe=new ValidationPipe({transform:true,whitelist:true});
 await assert.rejects(pipe.transform({sort:'bogus'},{type:'query',metatype:MisResidentialQueryDto}),/Bad Request/);
 await assert.rejects(pipe.transform({dir:'up'},{type:'query',metatype:MisResidentialQueryDto}),/Bad Request/);
 // 只影响 households：dashboard 带 sort/dir 与不带时 SQL 完全一致
 assert.equal(report({view:'dashboard',sort:'amount',dir:'desc'} as any).sql,report({view:'dashboard'}).sql,'其他视图排序不能变');
 // _aging:false（导出/内部全量扫描）强制回默认地址升序，不受 sort 参数影响
 const internal=report({view:'households',status:'unpaid',sort:'amount',dir:'desc',_aging:false} as any);
 assert.match(internal.sql,/ORDER BY l\.管理处 ASC,/,'内部扫描保持默认地址序');
 assert.doesNotMatch(internal.sql,/SUM\(w\.ZJ_JE\) DESC/,'内部扫描不得继承金额排序');
});

test('趋势隔离旧库非法日期并返回数据质量计数',()=>{const r=report({view:'trend',paidFrom:'2026-11-01',paidTo:'2026-11-04'});assert.match(r.sql,/CASE WHEN ISDATE\(w\.ZJ_SKRQ\)=1 THEN CONVERT\(datetime,w\.ZJ_SKRQ\) ELSE NULL END/);assert.match(r.sql,/CASE WHEN ISDATE\(w\.ZJ_TKRQ\)=1 THEN CONVERT\(datetime,w\.ZJ_TKRQ\) ELSE NULL END/);assert.match(r.sql,/AS invalidDateCount/)});

test('旧MIS日期参数使用无歧义112样式，不用不兼容的23输入样式',()=>{const r=report({view:'trend',paidFrom:'2026-11-01',paidTo:'2026-11-04'});assert.match(r.sql,/CONVERT\(datetime,REPLACE\(@paidFrom,'-',''\),112\)/);assert.doesNotMatch(r.sql,/CONVERT\(datetime,@paid(?:From|To),23\)/)});

// topHouses（底部 Top10 按户口径）服务层：真实 residential() 走 stub read，内层 _aging:false 扫描由 stub residential 提供。
function topHousesFixture(access:any){
 const scanRows=[
  {houseKey:'01:1:2',address:'合成花园1号102室',ownerName:'张三',amountCents:500000,phone:'13800000002',phoneMasked:'138****0002',periodFrom:'202501',periodTo:'202503'},
  {houseKey:'01:1:1',address:'合成花园1号101室',ownerName:'张三',amountCents:300000,phone:'13800000001',phoneMasked:'138****0001',periodFrom:'202401',periodTo:'202402'},
 ];
 const s:any=new MisFeesService({find:async()=>[{id:10,name:'合成花园'}]} as any,{} as any);
 s.scope=async()=>[{id:10,name:'合成花园',offices:['01']}];
 s.read=async()=>({recordsets:[[{total:'2',amount:'8000.00',receivableAmount:'8000.00',paidAmount:'0',unpaidAmount:'8000.00',unpaidHouses:2}],[]]});
 const real=s.residential.bind(s);
 s.residential=async(q:any,u:any,a:any)=>{
  if(q._aging===false)return {rows:scanRows,total:scanRows.length,amountCents:800000,communities:[{id:10,name:'合成花园'}]};
  return real(q,u,a);
 };
 return {s,user:{id:7,tenantId:1},access};
}
test('Top10按户口径：同名业主分两行不合并，金额降序且字段齐全',async()=>{
 const {s,user,access}=topHousesFixture({scopeAll:false,communityIds:[10],pages:{fees:{view:true,edit:false}}});
 const r:any=await s.residential({view:'households',status:'unpaid'},user,access);
 const top:any[]=r.aging.topHouses;
 assert.ok(Array.isArray(top),'aging.topHouses 必须是数组');
 assert.ok(top.length<=10,'Top10 最多 10 行');
 assert.equal(top.length,2);
 assert.deepEqual(top.map(row=>row.amountCents),[500000,300000],'按待缴金额降序');
 assert.deepEqual(top.map(row=>row.houseKey),['01:1:2','01:1:1']);
 assert.deepEqual(top.map(row=>row.ownerName),['张三','张三'],'同名业主按 houseKey 分成两行，不能按姓名合并');
 assert.notEqual(top[0].houseKey,top[1].houseKey);
 for(const row of top)for(const key of ['houseKey','address','ownerName','amountCents','phone','phoneMasked'])assert.ok(key in row,key+' 字段必须存在');
 assert.equal(top[0].address,'合成花园1号102室');
});
test('Top10按户口径二次收窄：只读账号 phone 全为 null 且 phoneMasked 非空；有收费编辑权限才带完整号码',async()=>{
 const viewOnly=topHousesFixture({scopeAll:false,communityIds:[10],pages:{fees:{view:true,edit:false}}});
 const viewed:any=await viewOnly.s.residential({view:'households',status:'unpaid'},viewOnly.user,viewOnly.access);
 for(const row of viewed.aging.topHouses){
  assert.equal(row.phone,null,'只读账号 Top10 行不能带完整手机号');
  assert.ok(row.phoneMasked&&row.phoneMasked.length>0,'脱敏号码必须非空');
 }
 assert.deepEqual(viewed.aging.topHouses.map((row:any)=>row.phoneMasked),['138****0002','138****0001']);
 const editable=topHousesFixture({scopeAll:false,communityIds:[10],pages:{fees:{view:true,edit:true}}});
 const edited:any=await editable.s.residential({view:'households',status:'unpaid'},editable.user,editable.access);
 assert.deepEqual(edited.aging.topHouses.map((row:any)=>row.phone),['13800000002','13800000001'],'有收费编辑权限才返回完整手机号');
});
test('趋势 bucket=month 按自然月聚合输出 YYYY-MM，默认仍按日；非法粒度拒绝',async()=>{
 const month=report({view:'trend',paidFrom:'2026-01-01',paidTo:'2026-12-31',bucket:'month'});
 assert.match(month.sql,/CONVERT\(varchar\(7\),/,'月粒度 SQL 取 YYYY-MM');
 assert.match(month.sql,/AS month/);assert.match(month.sql,/GROUP BY month ORDER BY month/);
 const day=report({view:'trend',paidFrom:'2026-01-01',paidTo:'2026-12-31'});
 assert.match(day.sql,/CONVERT\(varchar\(10\),/,'默认日粒度不变');assert.match(day.sql,/AS day/);
 assert.throws(()=>report({view:'trend',paidFrom:'2026-01-01',paidTo:'2026-12-31',bucket:'week'}),/趋势粒度/);
 const s:any=Object.create(MisFeesService.prototype);
 s.residentialScope=async()=>[{id:10,name:'合成小区',offices:['01']}];
 let reads=0;
 s.read=async()=>{reads++;return {recordsets:[[{month:'2026-01',netAmount:'12.34',chargedAmount:'20.00',refundedAmount:'7.66'},{month:'2026-02',netAmount:'1.00',chargedAmount:'1.00',refundedAmount:'0.00'}],[{invalidDateCount:2}]]}};
 const out:any=await s.residential({view:'trend',paidFrom:'2026-01-01',paidTo:'2026-12-31',bucket:'month',_aging:false},{id:1,tenantId:1},{scopeAll:true});
 assert.equal(reads,1,'月趋势只读一次MIS');assert.equal(out.bucket,'month');assert.equal(out.invalidDateCount,2);
 assert.deepEqual(out.rows,[{month:'2026-01',netCents:1234,chargedCents:2000,refundedCents:766},{month:'2026-02',netCents:100,chargedCents:100,refundedCents:0}]);
});
test('今日收款清单：date 过滤、分页 total/pageSize、page 越界空 rows，recordedAt/日期精度保留',async()=>{
 const s:any=Object.create(MisFeesService.prototype);
 s.collectionCommunities=async()=>[{id:10,name:'合成小区',offices:['01']}];
 let sql='',params:any=null;
 const row={officeCode:'01',address:'剑川路198弄1号101室',ownerName:'甲',paidDate:'2026-11-07',amount:'123.45',billCount:3,channel:'微信',recordedAt:'2026-11-07 11:39:00'};
 const row2={officeCode:'01',address:'剑川路198弄2号101室',ownerName:'乙',paidDate:'2026-11-07',amount:'10.00',billCount:2,channel:'现金',recordedAt:'2026-11-07 10:00:00'};
 s.read=async(q:any,p:any)=>{sql=q;params=p;return {recordsets:[[{total:'2',totalBills:'5'}],[row,row2]]}};
 const out:any=await s.recentPayments({date:'2026-11-07'},{id:1,tenantId:1},{scopeAll:true});
 assert.deepEqual({total:out.total,totalBills:out.totalBills,totalHouses:out.totalHouses,page:out.page,pageSize:out.pageSize}, {total:2,totalBills:5,totalHouses:2,page:1,pageSize:10});
 assert.equal(out.rows.reduce((n:number,r:any)=>n+r.billCount,0),out.totalBills,'totalBills=各行 billCount 之和');
 assert.equal(out.totalHouses,out.total,'totalHouses=聚合行数');
 assert.deepEqual(out.rows[0],{paidAt:'2026-11-07',paidDate:'2026-11-07',paidAtPrecision:'date',address:'剑川路198弄1号101室',ownerName:'甲',amountCents:12345,channel:'微信',billCount:3,recordedAt:'2026-11-07T11:39:00+08:00',recordedAtPrecision:'minute',communityId:10,communityName:'合成小区'});
 assert.match(sql,/SUM\(g\.billCount\).*AS totalBills/);assert.match(sql,/w\.ZJ_SKRQ>=CONVERT\(datetime,@date,120\)/);assert.match(sql,/BETWEEN @firstRow AND @lastRow/);assert.match(sql,/ORDER BY MAX\(w\.updatedate\) DESC,MAX\(w\.ZJ_ID\) DESC/);
 assert.deepEqual([params.date,params.firstRow,params.lastRow],['2026-11-07',1,10]);
 // 第3页越界：MIS total/totalBills 仍正确，rows 为空
 s.read=async()=>({recordsets:[[{total:'2',totalBills:'5'}],[]]});
 const beyond:any=await s.recentPayments({date:'2026-11-07',page:3,pageSize:10},{id:1,tenantId:1},{scopeAll:true});
 assert.deepEqual({total:beyond.total,totalBills:beyond.totalBills,totalHouses:beyond.totalHouses,page:beyond.page,pageSize:beyond.pageSize,rows:beyond.rows},{total:2,totalBills:5,totalHouses:2,page:3,pageSize:10,rows:[]});
 await assert.rejects(s.recentPayments({date:'2026-02-30'},{id:1,tenantId:1},{scopeAll:true}),/日期/);
 await assert.rejects(s.recentPayments({page:0},{id:1,tenantId:1},{scopeAll:true}),/page/);
 await assert.rejects(s.recentPayments({pageSize:51},{id:1,tenantId:1},{scopeAll:true}),/pageSize/);
 // 空数据/无授权范围
 s.read=async()=>({recordsets:[[{total:'0',totalBills:'0'}],[]]});
 assert.deepEqual(await s.recentPayments({date:'2026-11-08'},{id:1,tenantId:1},{scopeAll:true}),{total:0,totalBills:0,totalHouses:0,page:1,pageSize:10,rows:[]});
 s.collectionCommunities=async()=>[];
 assert.deepEqual(await s.recentPayments({date:'2026-11-10'},{id:1,tenantId:1},{scopeAll:true}),{total:0,totalBills:0,totalHouses:0,page:1,pageSize:10,rows:[]});
});
test('今日实收：空日期/空数据返回0，包含 byFee/byChannel 聚合与退款；非法日期拒绝',async()=>{
 const s:any=Object.create(MisFeesService.prototype);
 s.collectionCommunities=async()=>[{id:1,name:'合成小区',offices:['01']}];
 let sql='',params:any={};
  s.read=async(q:any,p:any)=>{sql=q;params=p;return {recordsets:[[{paidCount:'3',paidAmount:'123.45',paidHouses:'2'}],[{refundCount:'1',refundAmount:'10.00'}],[{feeCode:'property',feeName:'物业费',billCount:'2',houseCount:'1',paidAmount:'100.00'},{feeCode:'parking',feeName:'停车',billCount:'1',houseCount:'1',paidAmount:'23.45'}],[{channel:'微信',billCount:'2',houseCount:'2',paidAmount:'100.00'},{channel:'现金',billCount:'1',houseCount:'1',paidAmount:'23.45'}]]}};
 const out:any=await s.today({date:'2026-11-07'},{id:1,tenantId:1},{scopeAll:true});
  assert.deepEqual(out,{paidCents:12345,paidCount:3,refundedCents:1000,paidHouses:2,byFee:[{feeCode:'property',feeName:'物业费',paidCents:10000,billCount:2,houseCount:1},{feeCode:'parking',feeName:'停车',paidCents:2345,billCount:1,houseCount:1}],byChannel:[{channel:'微信',paidCents:10000,billCount:2,houseCount:2},{channel:'现金',paidCents:2345,billCount:1,houseCount:1}]});
 assert.equal(out.byFee[0].billCount,2);assert.equal(out.byFee[0].houseCount,1,'同户同日多张账单按房号去重只算1户');
 assert.equal((sql.match(/AS houseCount/g)||[]).length,2,'byFee/byChannel 都要按管理处+S_ID去重户数');
 assert.match(sql,/w\.ZJ_SKRQ>=CONVERT\(datetime,@date,120\)/);assert.match(sql,/ZJ_TKRQ IS NULL AND w\.ZJ_JE>0/);assert.equal(params.date,'2026-11-07');
 s.read=async()=>({recordsets:[[],[],[],[]]});
 assert.deepEqual(await s.today({date:'2026-11-08'},{id:1,tenantId:1},{scopeAll:true}),{paidCents:0,paidCount:0,refundedCents:0,paidHouses:0,byFee:[],byChannel:[]});
 await assert.rejects(s.today({date:'2026-02-30'},{id:1,tenantId:1},{scopeAll:true}),/日期/);
});
test('MIS短时缓存：同租户同参数30秒内第二次调用不再查MIS；amount-brackets一次SQL返回四档',async()=>{
 const make=(readImpl:any)=>{const s:any=Object.create(MisFeesService.prototype);s.collectionCommunities=async()=>[{id:10,name:'合成小区',offices:['01']}];s.residentialScope=async()=>[{id:10,name:'合成小区',offices:['01']}];let reads=0;s.read=async(q:any,p:any)=>{reads++;return readImpl()};return{s,reads:()=>reads}};
 const today=make(()=>({recordsets:[[{paidCount:'1',paidAmount:'1.00',paidHouses:'1'}],[{refundCount:'0',refundAmount:'0'}],[{feeName:'物业费',billCount:'1',houseCount:'1',paidAmount:'1.00'}],[{channel:'微信',billCount:'1',houseCount:'1',paidAmount:'1.00'}]]}));
 await today.s.today({date:'2026-11-07'},{id:1,tenantId:1},{scopeAll:true});
 await today.s.today({date:'2026-11-07'},{id:1,tenantId:1},{scopeAll:true});
 assert.equal(today.reads(),1,'today 第二次命中缓存');
 const recent=make(()=>({recordsets:[[{total:'1',totalBills:'2'}],[{officeCode:'01',address:'A',ownerName:'甲',paidDate:'2026-11-07',amount:'1.00',billCount:2,channel:'微信',recordedAt:'2026-11-07 10:00:00'}]]}));
 await recent.s.recentPayments({date:'2026-11-07',page:1,pageSize:10},{id:1,tenantId:1},{scopeAll:true});
 await recent.s.recentPayments({date:'2026-11-07',page:1,pageSize:10},{id:1,tenantId:1},{scopeAll:true});
 assert.equal(recent.reads(),1,'recent-payments 第二次命中缓存');
 const brackets=make(()=>({recordsets:[[{bucketKey:'le500',houseCount:'2',amount:'300.00'},{bucketKey:'gt5000',houseCount:'1',amount:'6000.00'}]]}));
 const first:any=await brackets.s.residential({view:'amount-brackets'},{id:1,tenantId:1},{scopeAll:true});
 assert.deepEqual(first.buckets.map((b:any)=>[b.key,b.count,b.amountCents]),[['le500',2,30000],['500to2000',0,0],['2000to5000',0,0],['gt5000',1,600000]]);
 assert.deepEqual(first.total,{count:3,amountCents:630000});
 await brackets.s.residential({view:'amount-brackets'},{id:1,tenantId:1},{scopeAll:true});
 assert.equal(brackets.reads(),1,'amount-brackets 第二次命中缓存');
 const sql=report({view:'amount-brackets'},['01']).sql;
 assert.ok(sql.includes('GROUP BY l.管理处,s.S_ID,z.ZH_ID'));assert.ok(sql.includes('h.amount*100<=50000'));
 // 权限范围不同不能复用缓存
 const other=make(()=>({recordsets:[[{bucketKey:'le500',houseCount:'0',amount:'0'}]]}));
 await other.s.residential({view:'amount-brackets'},{id:1,tenantId:1},{scopeAll:true});
 await other.s.residential({view:'amount-brackets'},{id:1,tenantId:1},{scopeAll:false,communityIds:[10]});
 assert.equal(other.reads(),2,'不同数据范围必须分别查MIS');
});


test('待缴金额分档必须先按户聚合，再按户级金额（分）分档，禁止用单条 ZJ_JE 分档', () => {
 const sql=report({view:'amount-brackets'},['01']).sql;
 assert.ok(sql.includes('SELECT SUM(w.ZJ_JE) AS amount'), '先按户聚合待缴金额');
 assert.ok(sql.includes('GROUP BY l.管理处,s.S_ID,z.ZH_ID'), '按管理处+房号+业主聚合到户');
 assert.ok(sql.includes('h.amount*100<=50000'), '户级金额由元转分后比较 ≤500 元');
 assert.ok(sql.includes('h.amount*100<=200000'), '户级金额比较 ≤2000 元');
 assert.ok(sql.includes('h.amount*100<=500000'), '户级金额比较 ≤5000 元');
 assert.ok(!/SUM\(w\.ZJ_JE\)[^)]*<=50000/.test(sql.replace(/\s+/g,' ')), '未直接用单条账单金额分档');
});


test('今日分项收入 byFee 返回中文名+英文 feeCode；details 按 category 过滤并分页', async () => {
 const s:any=Object.create(MisFeesService.prototype);
 s.collectionCommunities=async()=>[{id:10,name:'合成小区',offices:['01']}];
 let sql='',params:any={};
 s.read=async(q:any,p:any)=>{sql=q;params=p;return {recordsets:[[{total:'1'}],[{officeCode:'01',address:'A',ownerName:'甲',paidDate:'2026-11-08',amount:'100.00',billCount:2,channel:'微信',recordedAt:'2026-11-08 10:00:00'}]]}};
 const out:any=await s.todayDetails({category:'property',page:1,pageSize:20,date:'2026-11-08'},{id:1,tenantId:1},{scopeAll:true});
 assert.equal(out.total,1);assert.equal(out.page,1);assert.equal(out.pageSize,20);
 assert.deepEqual(out.rows,[{recordedAt:'2026-11-08T10:00:00+08:00',paidDate:'2026-11-08',address:'A',ownerName:'甲',channel:'微信',amountCents:10000,billCount:2}]);
 assert.match(sql,/property/);assert.ok(sql.includes('=@category'));assert.equal(params.category,'property');
 await assert.rejects(s.todayDetails({category:'bad'},{id:1,tenantId:1},{scopeAll:true}),/分类/);
});
