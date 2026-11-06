export interface MisBill { id:string; feeCode:string; feeName:string; period:string; amountCents:number; updatedAt?:string }
export interface MisHouse { houseKey:string; address:string; ownerName:string; communityId:number; communityName?:string; amountCents:number; billCount:number; periodFrom:string; periodTo:string; phoneMasked:string; contactEligible:boolean }
export interface Notice extends Omit<MisHouse,'billCount'|'periodFrom'|'periodTo'> { bills:MisBill[] }
export interface CollectionPreview { notices:Notice[]; totalCents:number; billCount:number; fingerprint:string; queriedAt:string; sourceLabel:string; skipped:string[]; contactEligibleCount:number; contactWarning:string; smsAvailable:false; smsReason:string }
export interface FeeSummary {receivableCents:number;paidCents:number;unpaidCents:number;unpaidHouses:number;adjustmentCount?:number}
export interface FeeGroup extends FeeSummary {feeCode:string;feeName:string;category:string}
export type Category='all'|'property'|'berth'|'other';
export function chinaDate(now=new Date()){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)}
export function trendRange(mode:'week'|'month',now=new Date()){
 const to=chinaDate(now),d=new Date(to+'T00:00:00Z');
 if(mode==='week')d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));else d.setUTCDate(1);
 return {from:d.toISOString().slice(0,10),to};
}
export function collectionRate(receivable:number,paid:number){return receivable>0?Math.round(paid/receivable*1000)/10:null}
export function sumCents(values:number[]){return values.reduce((a,b)=>{if(!Number.isSafeInteger(b)||!Number.isSafeInteger(a+b))throw new Error('金额超出安全范围');return a+b},0)}
export function cents(value:number){if(!Number.isSafeInteger(value))throw new Error('金额超出安全范围');return (value/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}
export function periodLabel(value:string){return /^\d{6}$/.test(value)?value.slice(0,4)+'年'+Number(value.slice(4))+'月':value||'未记录'}
export function escapeHtml(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}
export function feeCategory(name:string):Category{return /泊位|车位/.test(name)?'berth':/物业/.test(name)?'property':'other'}
export function noticeSmsText(n:Notice){
 const valid=/^(?!0000)\d{4}(0[1-9]|1[0-2])$/;
 const periods=[...new Set(n.bills.map(b=>b.period).filter(p=>valid.test(p)))].sort();
 const ranges:string[]=[];
 for(let i=0;i<periods.length;){
  let end=i+1;
  while(end<periods.length&&periods[end].slice(0,4)===periods[i].slice(0,4)&&Number(periods[end].slice(4))===Number(periods[end-1].slice(4))+1)end++;
  const first=periods[i],last=periods[end-1];
  ranges.push(`${first.slice(0,4)}年${Number(first.slice(4))}${end-i>1?'-'+Number(last.slice(4)):''}月`);i=end;
 }
 const unknown=n.bills.some(b=>!valid.test(b.period));
 const scope=ranges.length?ranges.join('、')+(unknown?'及部分账期待核对的账单':''):'账期待核对的账单';
 return `住宅物业服务费用尚有${scope}共计${cents(n.amountCents)}元待缴纳。请联系物业管理处核对办理，感谢您对我们工作的支持`;
}
// Only equal monthly charges can be combined: MIS does not expose a unit price.
export function noticeRows(bills:MisBill[]){
 const groups=new Map<string,MisBill[]>(),rows:MisBill[]=[];
 for(const b of bills){
  if(!/^(?!0000)\d{4}(0[1-9]|1[0-2])$/.test(b.period)){rows.push({...b});continue}
  const key=JSON.stringify([b.feeCode,b.feeName,b.amountCents]);
  const group=groups.get(key);if(group)group.push(b);else groups.set(key,[b]);
 }
 for(const group of groups.values()){
  const sorted=[...group].sort((a,b)=>a.period.localeCompare(b.period));
  const counts=new Map<string,number>();for(const b of sorted)counts.set(b.period,(counts.get(b.period)||0)+1);
  const ordinal=(b:MisBill)=>Number(b.period.slice(0,4))*12+Number(b.period.slice(4))-1;
  for(let i=0;i<sorted.length;){
   let end=i+1;
   while(end<sorted.length&&counts.get(sorted[end-1].period)===1&&counts.get(sorted[end].period)===1&&ordinal(sorted[end])===ordinal(sorted[end-1])+1)end++;
   const first=sorted[i],last=sorted[end-1];
   const period=end-i===1?periodLabel(first.period):first.period.slice(0,4)===last.period.slice(0,4)?`${first.period.slice(0,4)}年${Number(first.period.slice(4))}—${Number(last.period.slice(4))}月`:`${periodLabel(first.period)}—${periodLabel(last.period)}`;
   rows.push({...first,period,amountCents:sumCents(sorted.slice(i,end).map(b=>b.amountCents))});i=end;
  }
 }
 return rows;
}
export function renderNoticeDocument(notices:Notice[],options:{queriedAt:string;batchNo:string;paper:'A5'|'A4';printedAt?:Date}){
 const esc=escapeHtml,pages:string[]=[],printedDate=chinaDate(options.printedAt??new Date());
 for(const n of notices){const displayRows=noticeRows(n.bills),count=Math.ceil(displayRows.length/8);for(let page=0;page<count;page++){
 const rows=displayRows.slice(page*8,(page+1)*8);
 const community=n.communityName||'',office=/^枫桦(?:景苑)?(?:一期|二期)?$/.test(community)?'枫桦景苑':community;
 pages.push(`<article class="notice" data-notice-page="${page+1}"><header><h1>物业服务费用缴费通知单</h1></header>${page?`<p class="continue">续页（第 ${page+1}/${count} 页）</p>`:''}<div class="address"><b>${esc(n.address)}</b><p>${esc(n.ownerName||'住户')}，您好：</p></div><p>您目前有以下物业费账单未缴纳，请及时缴纳，感谢您对我们工作的支持。</p><table><thead><tr><th>收费项目</th><th>所属账期</th><th class="money">待缴金额（元）</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${esc(b.feeName)}</td><td>${esc(b.period)}</td><td class="money">${cents(b.amountCents)}</td></tr>`).join('')}</tbody></table>${page===count-1?`<div class="total">本户本次通知合计 <b>¥${cents(n.amountCents)}</b></div><footer><p>如果您已缴费请通知我们再次核对。</p><p class="signature">${esc(office)}物业管理处<br>打印日期：${esc(printedDate)}</p></footer>`:'<p class="continue">明细续下页，本页不重复计合计。</p>'}</article>`);
 }}
 const sheets:string[]=[];for(let i=0;i<pages.length;i+=options.paper==='A4'?2:1)sheets.push(`<section class="paper">${pages.slice(i,i+(options.paper==='A4'?2:1)).join('')}</section>`);
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>缴费通知单</title><style>@page {size:${options.paper==='A4'?'A4 landscape':'A5 portrait'};margin:0}*{box-sizing:border-box}body{margin:0;background:white;color:#111;font:12pt/1.55 'Microsoft YaHei',sans-serif}.paper{width:${options.paper==='A4'?'297':'148'}mm;min-height:210mm;padding:9mm;break-after:page;${options.paper==='A4'?'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14mm;':''}}.paper:last-child{break-after:auto}.notice{min-width:0;break-inside:avoid}h1{font-size:16pt;text-align:center;margin:4mm 0 2mm}header{border-bottom:1px solid #444;padding-bottom:2mm}p{margin:2mm 0}.address{margin:4mm 0 2mm}.address b{font-size:13pt;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;margin:3mm 0}th,td{padding:2.1mm 1mm;border-bottom:1px solid #bbb;text-align:left;font-size:11pt;overflow-wrap:anywhere}th{font-size:10pt}td:nth-child(2){overflow-wrap:anywhere}.money{text-align:right;white-space:nowrap}.total{text-align:right;margin:4mm 0;font-size:12pt}.total b{font-size:16pt;margin-left:5mm}footer{font-size:10pt;border-top:1px solid #777;padding-top:2mm;break-inside:avoid}.signature{text-align:right}.continue{font-size:10pt}tr{break-inside:avoid}@media screen{body{background:#eee;padding:20px}.paper{margin:0 auto 20px;background:white;padding:9mm;box-shadow:0 1px 6px #0002}}</style></head><body>${sheets.join('')}</body></html>`;
}
export async function printNotices(notices:Notice[],options:{queriedAt:string;batchNo:string;paper:'A5'|'A4'},isCurrent:()=>boolean=()=>true){
 if(!isCurrent())return;
 const frame=document.createElement('iframe');frame.title='缴费通知单打印';frame.style.cssText='position:fixed;left:-20000px;top:0;width:800px;height:1000px;border:0';document.body.appendChild(frame);
 const doc=frame.contentDocument;if(!doc){frame.remove();throw new Error('打印文档未能打开，请重试')}
 doc.open();doc.write(renderNoticeDocument(notices,options));doc.close();await doc.fonts.ready;await new Promise(r=>setTimeout(r,250));
 if(!isCurrent()){frame.remove();return}
 const close=()=>{frame.remove();window.removeEventListener('afterprint',close)};frame.contentWindow!.addEventListener('afterprint',close,{once:true});setTimeout(()=>{if(frame.isConnected)frame.remove()},300000);frame.contentWindow!.focus();frame.contentWindow!.print();
}
