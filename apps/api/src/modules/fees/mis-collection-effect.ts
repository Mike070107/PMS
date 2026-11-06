export interface EffectBill { id:string;houseKey:string;amountCents:number;paidAt?:string|null }
export interface EffectBatch { id:number;createdAt:Date|string;snapshot:any;communityIds:number[] }
const safe=(v:number)=>{if(!Number.isSafeInteger(v)||v<0)throw new Error('催收金额必须是非负安全整数');return v};
const add=(a:number,b:number)=>safe(a+b);
export function effectDay(value:Date|string){const d=new Date(value);if(!Number.isFinite(d.getTime()))throw new Error('批次日期非法');return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function stamp(day:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return null;const d=Date.parse(day+'T00:00:00Z');return Number.isFinite(d)&&new Date(d).toISOString().slice(0,10)===day?d:null}
/** 已确认：ZJ_SKRQ、原账单、T+30自然日、最近批次、单户封顶。 */
export function collectionEffects(batches:EffectBatch[],payments:EffectBill[]){
 const rows=batches.map(b=>({id:b.id,createdAt:b.createdAt,day:effectDay(b.createdAt),notifiedCents:0,recoveredCents:0,recoveryRate:0,clearedHouseholds:0,averagePaymentDays:null as number|null,amountWeightedDays:null as number|null,details:[] as any[],daySum:0,dayWeight:0,paymentCount:0}));
 const byId=new Map(rows.map(r=>[r.id,r]));const candidates=new Map<string,Array<{batch:EffectBatch;notice:any;bill:any}>>();
 for(const b of batches){const r=byId.get(b.id)!;const notices=b.snapshot?.notices;if(!Array.isArray(notices))throw new Error('通知快照不完整，不能推算催收效果');const houseSeen=new Set<string>();
  for(const n of notices){if(houseSeen.has(n.houseKey)||!Array.isArray(n.bills))throw new Error('通知责任对象或账单快照不合法');houseSeen.add(n.houseKey);safe(n.amountCents);const amount=n.bills.reduce((a:number,v:any)=>add(a,safe(v.amountCents)),0);if(amount!==n.amountCents)throw new Error('通知快照合计不一致');r.notifiedCents=add(r.notifiedCents,amount);r.details.push({houseKey:n.houseKey,address:n.address,ownerName:n.ownerName,notifiedCents:amount,recoveredCents:0,cleared:false,bills:[]});
   const seen=new Set<string>();for(const bill of n.bills){if(seen.has(String(bill.id)))throw new Error('通知快照含重复账单');seen.add(String(bill.id));const key=n.houseKey+'|'+bill.id;const list=candidates.get(key)||[];list.push({batch:b,notice:n,bill});candidates.set(key,list)}
  }
 }
 let invalidPaidDateCount=0,naturalRecoveryCents=0;const seenPayments=new Set<string>();
 for(const p of [...payments].sort((a,b)=>String(a.paidAt).localeCompare(String(b.paidAt))||a.id.localeCompare(b.id))){safe(p.amountCents);const key=p.houseKey+'|'+p.id;if(seenPayments.has(key))throw new Error('MIS已缴账单重复，无法确认回款');seenPayments.add(key);const paid=stamp(p.paidAt||'');if(paid===null){invalidPaidDateCount++;continue}
  const eligible=(candidates.get(key)||[]).map(c=>({...c,days:(paid-stamp(effectDay(c.batch.createdAt))!)/86400000})).filter(c=>c.days>=0&&c.days<=30).sort((a,b)=>new Date(b.batch.createdAt).getTime()-new Date(a.batch.createdAt).getTime()||b.batch.id-a.batch.id);
  const win=eligible[0];if(!win){naturalRecoveryCents=add(naturalRecoveryCents,p.amountCents);continue}
  const r=byId.get(win.batch.id)!,h=r.details.find(h=>h.houseKey===p.houseKey)!;const amount=Math.min(p.amountCents,win.bill.amountCents,h.notifiedCents-h.recoveredCents);h.recoveredCents=add(h.recoveredCents,amount);r.recoveredCents=add(r.recoveredCents,amount);h.bills.push({id:p.id,paidAt:p.paidAt,actualCents:p.amountCents,attributedCents:amount,days:win.days});if(amount){r.paymentCount++;r.daySum+=win.days;r.dayWeight+=amount*win.days;if(!Number.isSafeInteger(r.dayWeight))throw new Error('回款天数计算超出安全范围')}
 }
 for(const r of rows){for(const h of r.details){h.cleared=h.notifiedCents>0&&h.recoveredCents===h.notifiedCents;if(h.cleared)r.clearedHouseholds++}r.recoveryRate=r.notifiedCents?Math.round(r.recoveredCents/r.notifiedCents*10000)/100:0;r.averagePaymentDays=r.paymentCount?Math.round(r.daySum/r.paymentCount*100)/100:null;r.amountWeightedDays=r.recoveredCents?Math.round(r.dayWeight/r.recoveredCents*100)/100:null}
 return {rows,invalidPaidDateCount,naturalRecoveryCents,policy:{dateField:'ZJ_SKRQ',windowDays:30,timezone:'Asia/Shanghai',sameDayPrecision:'同日收款无法判断时分先后',overlap:'最近有效批次',matching:'通知快照原账单',averageDays:'逐笔平均与金额加权分别列示，不混用'}};
}

export function promiseProgress(p:{houseKey:string;promisedCents:string;createdAt:Date|string;snapshot:Record<string,unknown>},payments:EffectBill[]){
 const bills=p.snapshot.bills;if(!Array.isArray(bills))throw new Error('承诺账单快照不完整');const originals=new Map<string,number>();for(const b of bills){if(originals.has(String(b.id)))throw new Error('承诺快照含重复账单');originals.set(String(b.id),safe(b.amountCents))}
 let recoveredCents=0,invalidPaidDateCount=0;const seen=new Set<string>(),start=stamp(effectDay(p.createdAt))!;for(const b of payments){if(b.houseKey!==p.houseKey)continue;if(seen.has(b.id))throw new Error('MIS已缴账单重复，无法核对承诺');seen.add(b.id);safe(b.amountCents);const day=stamp(b.paidAt||'');if(day===null){invalidPaidDateCount++;continue}if(day>=start&&originals.has(b.id))recoveredCents=add(recoveredCents,Math.min(b.amountCents,originals.get(b.id)!))}
 return {recoveredCents,invalidPaidDateCount,fulfilled:recoveredCents>=safe(Number(p.promisedCents)),sameDayPrecision:'同日收款无法判断时分先后'};
}
