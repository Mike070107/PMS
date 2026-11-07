import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MisFeesService } from './mis-fees.service';

/** 对账 CSV：BOM/表头/行数/分页/转义/通知状态/文件名/超限与口径拒绝。用合成 households 结果，不连 MIS。 */
test('对账CSV导出：UTF-8 BOM、表头与逐户行数、5000分页全量、通知状态和2万户上限',async()=>{
 const s:any=Object.create(MisFeesService.prototype);
 const calls:any[]=[];
 const row=(i:number)=>({houseKey:`01:${i}:${100+i}`,officeCode:'01',communityId:10,address:'合成花园1栋100室, "加引号"',ownerName:'张,三',phoneMasked:'138****1234',amountCents:123400,billCount:2,periodFrom:'202501',periodTo:'202512'});
 const all=Array.from({length:5001},(_,i)=>row(i));
 s.residential=async(q:any)=>{calls.push({...q});return {rows:all.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:all.length,amountCents:all.length*123400,communities:[{id:10,name:'合成花园',offices:['01']}]}};
 s.notificationStatus=async(keys:string[])=>{const out=new Map();if(keys.includes('01:2:102'))out.set('01:2:102',{printedAt:'2026-11-01T02:00:00.000Z',printedPaper:'A4',smsAt:null,smsStatus:null});if(keys.includes('01:3:103'))out.set('01:3:103',{printedAt:null,printedPaper:null,smsAt:'2026-11-02T02:00:00.000Z',smsStatus:'delivered'});return out};
 const user:any={id:7,tenantId:1},access:any={scopeAll:true,pages:{fees:{view:true,edit:true}}};
 const file=await s.exportResidentialCsv({communityId:10,category:'property',q:'合成'},user,access);
 assert.match(file.filename,/^待缴对账_\d{8}_\d{4}\.csv$/,'文件名格式');
 assert.match(file.disposition,/attachment; filename="unpaid-reconciliation\.csv"; filename\*=UTF-8''/);
 const parts:string[]=[];for await(const chunk of file.stream)parts.push(String(chunk));
 const text=parts.join('');
 assert.equal(text.charCodeAt(0),0xFEFF,'必须以 UTF-8 BOM 开头，Excel 不乱码');
 const lines=text.replace(/^\uFEFF/,'').trimEnd().split('\r\n');
 assert.equal(lines[0],'小区,房号,业主,电话(脱敏),待缴金额(元),账期起,账期止,笔数,通知状态','表头列与顺序');
 assert.equal(lines.length,1+5001,'表头 + 全部 5001 户，不能只导当前页');
 assert.equal(lines[1],'合成花园,"合成花园1栋100室, ""加引号""","张,三",138****1234,1234.00,202501,202512,2,未通知','逗号/引号按 RFC4180 转义');
 assert.ok(text.includes(',A4已打印\r\n'),'打印登记 → A4已打印');
 assert.ok(text.includes(',短信已发\r\n'),'短信 submitted/delivered → 短信已发');
 assert.doesNotMatch(text,/1380000\d{4}/,'只导出脱敏号码');
 assert.equal(calls.length,2,'5001 户按 5000 一页循环取数');
 assert.equal(calls[0].view,'households');assert.equal(calls[0].status,'unpaid');assert.equal(calls[0].pageSize,5000);assert.equal(calls[0]._aging,false,'导出跳过账龄扫描');
 assert.equal(calls[1].page,2);assert.equal(calls[0].q,'合成');assert.equal(calls[0].category,'property');
 s.residential=async()=>({rows:[],total:20001,amountCents:0,communities:[]});
 await assert.rejects(s.exportResidentialCsv({},user,access),/20000|2 万|两万/,'超过上限必须拒绝而不是截断');
 await assert.rejects(s.exportResidentialCsv({status:'paid'},user,access),/待缴/,'已缴视图不是对账导出');
 await assert.rejects(s.exportResidentialCsv({houseKeys:['01:1:1']},user,access),/全量/,'导出不接受逐个住户');
});

test('对账CSV导出：导出期间户数增长超上限时停止写入并追加截断警告，不在已发响应头后抛错',async()=>{
 const s:any=Object.create(MisFeesService.prototype);
 const row=(i:number)=>({houseKey:`01:${i+1}:1`,officeCode:'01',communityId:10,address:'合成花园'+i+'号',ownerName:'业主'+i,phoneMasked:'138****1234',amountCents:100,billCount:1,periodFrom:'202501',periodTo:'202501'});
 // 首屏 total=20000 未超限，但第一页意外带回 20001 行（模拟导出期间增长）；流内到第 20001 行必须停止写入，不能抛普通 Error。
 s.residential=async()=>({rows:Array.from({length:20001},(_,i)=>row(i)),total:20000,amountCents:0,communities:[{id:10,name:'合成花园'}]});
 s.notificationStatus=async()=>new Map();
 const user:any={id:7,tenantId:1},access:any={scopeAll:true};
 const file=await s.exportResidentialCsv({},user,access);
 const parts:string[]=[];for await(const chunk of file.stream)parts.push(String(chunk));
 const lines=parts.join('').replace(/^\uFEFF/,'').trimEnd().split('\r\n');
 assert.equal(lines.length,1+20000+1,'表头 + 上限内 20000 行 + 1 行明确截断警告');
 assert.match(lines[lines.length-1],/超过上限 20000 户/,'截断警告必须写明上限');
 assert.match(lines[lines.length-1],/已截断/);
 assert.match(lines[lines.length-1],/缩小范围/);
});

test('对账CSV导出：公式注入防护覆盖 = + - @ 与前导 Tab/CR，普通值不变',async()=>{
 const s:any=Object.create(MisFeesService.prototype);
 const ownerNames=['=SUM(1)','+cmd','@evil','-1+1','\tTAB','\rCR','普通业主'];
 s.residential=async()=>({rows:ownerNames.map((ownerName,i)=>({houseKey:`01:${i+1}:1`,officeCode:'01',communityId:10,address:'甲1号',ownerName,phoneMasked:'138****1234',amountCents:100,billCount:1,periodFrom:'202501',periodTo:'202501'})),total:ownerNames.length,amountCents:0,communities:[{id:10,name:'合成花园'}]});
 s.notificationStatus=async()=>new Map();
 const file=await s.exportResidentialCsv({}, {id:7,tenantId:1} as any, {scopeAll:true} as any);
 const parts:string[]=[];for await(const chunk of file.stream)parts.push(String(chunk));
 const text=parts.join('');
 for(const value of ['=SUM(1)','+cmd','@evil','-1+1']){
  assert.ok(text.includes("甲1号,'"+value+','),value+' 必须以单引号开头，避免 Excel 当公式执行');
  assert.ok(!text.includes('甲1号,'+value+','),value+' 不能原样导出');
 }
 assert.ok(text.includes("甲1号,'\tTAB,"),'OWASP 建议：前导 Tab 也要加单引号');
 assert.ok(text.includes('甲1号,"\'\rCR",'),'OWASP 建议：前导 CR 加单引号并按 RFC4180 加引号');
 assert.ok(text.includes('甲1号,普通业主,'),'普通文本不加前缀，不破坏原有内容');
});

test('住宅清单返回11位手机号，但同一份数据走CSV导出仍必须是脱敏号码',async()=>{
 const s:any=Object.create(MisFeesService.prototype);
 s.scope=async()=>[{id:10,name:'合成花园',offices:['01']}];
 const detail=(phone:string)=>({houseKey:`01:1:${phone.length}`,officeCode:'01',address:'合成花园1号'+phone.length+'室',ownerName:'合成业主',phone,billCount:'1',amount:'123.40',periodFrom:'202501',periodTo:'202501'});
 s.read=async()=>({recordsets:[[{total:'3',amount:'370.20'}],[detail('13800000001'),detail('0571-12345678'),detail('')]]});
 const user:any={id:7,tenantId:1},access:any={scopeAll:true,pages:{fees:{view:true,edit:true}}};
 const list:any=await s.residential({view:'households',status:'unpaid'},user,access);
 assert.equal(list.rows[0].phone,'13800000001','11 位手机号才返回完整 phone，供需要时人工联系');
 assert.equal(list.rows[0].phoneMasked,'138****0001');
 assert.equal(list.rows[0].contactEligible,true);
 assert.equal(list.rows[1].phone,undefined,'非手机号不能给完整 phone');
 assert.equal(list.rows[1].phoneMasked,'号码待核实');
 assert.equal(list.rows[1].contactEligible,false);
 assert.equal(list.rows[2].phone,undefined);
 assert.equal(list.rows[2].phoneMasked,'未留手机号');

 const viewerAccess:any={scopeAll:true,pages:{fees:{view:true}}};
 const viewer:any=await s.residential({view:'households',status:'unpaid'},user,viewerAccess);
 assert.equal(viewer.rows[0].phone,undefined,'没有收费编辑权限时不下发完整手机号');
 assert.equal(viewer.rows[0].phoneMasked,'138****0001','只读用户仍拿到脱敏号码');
 // 同一份数据（同一 read 结果）走对账 CSV：必须只输出脱敏列，不能出现明文手机号或非手机号原文。
 const file=await s.exportResidentialCsv({},user,access);
 const parts:string[]=[];for await(const chunk of file.stream)parts.push(String(chunk));
 const text=parts.join('');
 assert.ok(text.includes('电话(脱敏)'),'CSV 表头仍是脱敏列');
 assert.ok(text.includes('138****0001'),'CSV 保留脱敏号码');
 assert.ok(!text.includes('13800000001'),'CSV 不能出现完整手机号');
 assert.ok(!text.includes('0571-12345678'),'CSV 不能出现非手机号原文');
 assert.doesNotMatch(text,/1[3-9]\d{9}/,'CSV 全文不得出现任何 11 位手机号明文');
});
