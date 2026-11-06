// Synthetic transport for actual React components. No external network.
const w=window as any;w.__calls=[];w.__events=[];let promises:any[]=[],holds:any[]=[],events:any[]=[],prints:any[]=[];
const row={houseKey:'01:1:1',address:'合成小区1号101室',ownerName:'合成责任人',communityId:10,communityName:'合成小区',amountCents:120000,billCount:12,periodFrom:'202501',periodTo:'202512',phoneMasked:'未留手机号',contactEligible:false};
const bills=Array.from({length:12},(_,i)=>({id:String(i+1),feeCode:'01',feeName:'物业管理费',period:'2025'+String(i+1).padStart(2,'0'),amountCents:10000}));
const preview=()=>({notices:[{...row,bills}],totalCents:row.amountCents,billCount:12,fingerprint:'a'.repeat(64),queriedAt:'2026-11-06T00:00:00Z',sourceLabel:'一通MIS（合成夹具）',skipped:[],excludedHolds:[],contactEligibleCount:0,contactWarning:'合成数据',smsReason:'合成提示：签名或模板尚未审核',smsAvailable:false});
const batch=(id=1)=>({id,createdAt:'2026-11-01T00:00:00Z',purpose:id===2?'sms':'print',houseCount:1,amountCents:'120000',snapshot:preview(),prints,timeline:events});
export async function request<T>(o:any):Promise<T>{w.__calls.push(JSON.parse(JSON.stringify(o)));await new Promise(r=>setTimeout(r,35));
 if(o.url==='/fees/mis/options')return {available:true,communities:[{id:10,name:'合成小区'}],feeItems:[{code:'01',name:'物业管理费'}],smsReadiness:{configured:false,enabled:false,canSend:false,reason:'合成提示：签名或模板尚未审核'}} as T;
 if(o.url==='/fees/mis/residential')return (o.query.view==='detail'?{rows:bills}:{rows:[row],total:1,amountCents:row.amountCents,queriedAt:'2026-11-06'}) as T;
 if(o.url==='/fees/mis/collections/followups'){
  if(o.method==='POST'){const d=o.data,e={id:events.length+1,houseKey:d.houseKey,action:d.action,note:d.note,createdBy:7,createdAt:'2026-11-06T00:00:00Z'};events.push(e);if(d.action==='promise')promises.push({id:1,houseKey:d.houseKey,promisedDate:d.promisedDate,promisedCents:String(d.promisedCents),fulfilled:false,overdue:true});if(d.action==='hold')holds.push({id:1,houseKey:d.houseKey,reason:d.reason,until:d.until});if(d.action==='cancel_hold')holds=[];return e as T}
  return {promises,holds,events,followupHouseholds:promises.length} as T;
 }
 if(o.url==='/fees/mis/collections/preview')return preview() as T;
 if(o.url==='/fees/mis/collections')return (o.method==='POST'?batch():{rows:[batch(),batch(2)],total:2}) as T;
 if(o.url==='/fees/mis/collections/effect'){if(w.__failEffect)throw Error('合成效果查询失败，请重试');return {rows:[{id:1,day:'2026-11-01',notifiedCents:120000,recoveredCents:30000,recoveryRate:25,clearedHouseholds:0,averagePaymentDays:3,amountWeightedDays:3,details:[{...row,notifiedCents:120000,recoveredCents:30000,cleared:false}]}],total:1,summary:{notifiedCents:120000,recoveredCents:30000,recoveryRate:25,clearedHouseholds:0},invalidPaidDateCount:1} as T}
 if(o.url==='/fees/mis/collections/1/prints'){if(w.__failPrint){w.__failPrint=false;throw Error('合成打印登记失败，未打印')}w.__events.push('registered');const p={id:prints.length+1,...o.data,printedAt:'2026-11-06T00:00:00Z',noticePageCount:1,operatorId:7};prints.push(p);return p as T}
 if(o.url==='/fees/mis/collections/1'||o.url==='/fees/mis/collections/2')return batch(o.url.endsWith('/2')?2:1) as T;
 throw Error('unhandled isolated fixture endpoint');
}
