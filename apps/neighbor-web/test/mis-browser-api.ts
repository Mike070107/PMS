// Entirely synthetic transport for real-component Chrome tests. Never calls production.
const w=window as unknown as {__calls:any[];__mode?:string;__state?:string;__fail?:boolean};w.__calls=[];let original:any=null;
export const repairs={list:async()=>[]};
export async function request<T>(o:any):Promise<T>{w.__calls.push(JSON.parse(JSON.stringify(o)));await new Promise(r=>setTimeout(r,35));if(w.__fail){w.__fail=false;throw Error('synthetic failure')}
 if(o.url==='/fees/mis/postings/readiness')return{enabled:w.__mode!=='off',methods:w.__mode==='off'?[]:['cash','wechat','alipay'],reason:w.__mode==='off'?'本人MIS映射未核实，仅核对应收':'当前员工配置已匹配，提交时仍核验源账与封帐'} as T;
 const row=()=>({id:19,status:'paid',txnNo:'MIS-SYNTHETIC',receiptNo:'PMS:SYNTHETIC',amountCents:12345,paymentMethod:'现金',externalSyncStatus:w.__state||'mis_queued',execution:{lastError:null},address:'合成小区1号101室'});
 if(o.url==='/fees/mis/postings/lookup')return{found:!!original,posting:original?row():undefined} as T;
 if(o.url==='/fees/mis/postings'&&o.method==='POST'){original=o.data;return row() as T}
 if(o.url==='/fees/mis/postings/19'||o.url==='/fees/mis/postings/19/retry')return row() as T;
 if(o.url==='/business/transaction-ledger'){if(o.query.q==='error')throw Error('synthetic failure');const page=o.query.page||1,size=o.query.pageSize||20;return{rows:Array.from({length:Math.min(size,Math.max(0,26-(page-1)*size))},(_,i)=>({id:(page-1)*size+i+1,txnNo:'MIS-SYNTHETIC-'+i,serviceType:'mis_property',status:'paid',amountCents:100,paymentMethod:'cash',externalSyncStatus:'mis_queued',createdAt:'2026-11-06T01:00:00+08:00',address:'合成小区1号'+(101+i)+'室',cashier:'合成员工'})),total:26,page,pageSize:size,summary:{paidCents:2600,refundedCents:0,netCents:2600,paidCount:26,freeCount:0,syncedCount:0,byService:[{serviceType:'mis_property',paidCents:2600,paidCount:26}]}} as T}
 throw Error('unhandled synthetic endpoint '+o.url);
}
