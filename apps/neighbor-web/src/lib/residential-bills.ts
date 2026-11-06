export interface MisBill { id:string; feeCode:string; feeName:string; period:string; amountCents:number; updatedAt?:string }
export interface MisHouse { houseKey:string; address:string; ownerName:string; communityId:number; communityName?:string; amountCents:number; billCount:number; periodFrom:string; periodTo:string; phoneMasked:string; contactEligible:boolean }
export interface Notice extends Omit<MisHouse,'billCount'|'periodFrom'|'periodTo'> { bills:MisBill[] }
export interface CollectionPreview { excludedHolds?:{houseKey:string;reason:string;until:string}[]; notices:Notice[]; totalCents:number; billCount:number; fingerprint:string; queriedAt:string; sourceLabel:string; skipped:string[]; contactEligibleCount:number; contactWarning:string; smsAvailable:false; smsReason:string }
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
 return `${n.address}业主您好，您有${scope}共计${cents(n.amountCents)}元的物业费账单待缴纳，请及时联系物业管理处核对办理，感谢您对我们工作的支持`;
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
 const periodCell=(value:string)=>{const s=String(value??'');if(s.length!==6)return s;const y=Number(s.slice(0,4)),m=Number(s.slice(4));return y>=1900&&y<=2999&&m>=1&&m<=12?periodLabel(s):s};
 const cn=(value:number)=>{const D=['零','壹','贰','叁','肆','伍','陆','柒','捌','玖'],U=['','拾','佰','仟'],S=['','万','亿'];const n=Math.abs(Math.round(value||0));if(!n)return '零元整';const seg=(x:number)=>{const parts:number[]=[];let r=x;while(r>0){parts.push(r%10000);r=Math.floor(r/10000)}let out='';for(let i=parts.length-1;i>=0;i--){const sec=parts[i];if(!sec)continue;let part='',zero=false;const ds=String(sec).split('').map(Number);for(let k=0;k<ds.length;k++){const v=ds[k];if(!v){zero=true;continue}if(zero&&part)part+='零';zero=false;part+=D[v]+U[ds.length-k-1]}if(out&&sec<1000)out+='零';out+=part+S[i]}return out.replace(/零+/g,'零').replace(/零$/,'')};const yuan=Math.floor(n/100),jiao=Math.floor((n%100)/10),fen=n%10;let text=yuan?seg(yuan)+'元':'';if(jiao)text+=D[jiao]+'角';if(fen){if(yuan&&!jiao)text+='零';text+=D[fen]+'分'}if(!fen)text+='整';return text};
 for(const n of notices){
  if(!Number.isSafeInteger(n.amountCents)||n.bills.some(b=>!Number.isSafeInteger(b.amountCents))||!Number.isSafeInteger(n.bills.reduce((s,b)=>s+b.amountCents,0)))throw new Error('金额超出安全范围');
  const displayRows=[...n.bills].sort((a,b)=>String(a.period).localeCompare(String(b.period)));
  const count=Math.max(1,Math.ceil(displayRows.length/12));
  const periodFrom=displayRows.length?periodCell(displayRows[0].period):'',periodTo=displayRows.length?periodCell(displayRows[displayRows.length-1].period):'';
  for(let page=0;page<count;page++){
   const rows=displayRows.slice(page*12,(page+1)*12),last=page===count-1;
   const community=n.communityName||'',office=/^枫桦(?:景苑)?(?:一期|二期)?$/.test(community)?'枫桦景苑':community;
   pages.push(`<article class="notice" data-notice-page="${page+1}"><header class="hd"><div class="org"><b>${esc(office)}物业服务中心</b><small>请核对房号、账期与金额，如有疑问请联系服务中心</small></div><div class="doc"><span>缴费通知单</span><small>编号 ${esc(options.batchNo)}</small><small>开单 ${esc(printedDate)}</small></div></header><div class="rule"></div><div class="title"><h1>物业服务费用缴费通知单</h1><div class="sub">所属账期 <b>${esc(periodFrom)}${periodTo&&periodTo!==periodFrom?' — '+esc(periodTo):''}</b><br>共 ${count} 页 · 第 ${page+1} 页${last?'':' · 续页'}</div></div><section class="facts"><div><span>房号</span><b>${esc(n.address)}</b></div><div><span>业主</span><b>${esc(n.ownerName||'住户')}</b></div><div><span>联系电话</span><b>${esc(n.phoneMasked||'—')}</b></div><div><span>待缴笔数</span><b>${n.bills.length} 笔</b></div></section><p class="lead">您目前有以下物业费账单未缴纳，请及时缴纳，感谢您对我们工作的支持。</p><table><thead><tr><th style="width:36%">所属账期</th><th>收费项目</th><th class="money" style="width:22%">待缴金额（元）</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${esc(periodCell(b.period))}</td><td>${esc(b.feeName)}</td><td class="money">${cents(b.amountCents)}</td></tr>`).join('')}</tbody></table>${last?`<div class="total">本户本次通知合计 <b>¥${cents(n.amountCents)}</b></div><div class="upper">人民币大写：<b>${cn(n.amountCents)}</b></div><div class="pay"><div><b>扫码缴费</b><small>小程序缴费码<br>扫码 → 选房号 → 勾账期</small></div><div><b>银行转账</b><small>户名 / 开户行 / 账号以服务中心公布为准<br>备注：房号 + 账期</small></div><div><b>服务中心</b><small>8:30–17:30 · 周一至周日<br>现金 / 微信 / 支付宝 / 刷卡</small></div></div><div class="callout"><b>线上缴费已开通</b><p>微信扫码进入缴费页，选房号、勾账期即可付款，实时销账，电子收据当场生成。</p></div><div class="notes"><p>· 扫码后请先核对房号与账期，系统按所选账期逐期销账。</p><p>· 转账或前台缴费，款项到账后 1 个工作日内自动销账。</p><p>· 需发票或纸质收据请到服务中心登记抬头与税号。</p></div><footer><div class="foot-note">本单为欠费提醒，不作为收款凭证；缴费以收据或电子收据为准。</div><div class="signature">${esc(office)}物业管理处<br>打印日期：${esc(printedDate)}</div></footer>`:`<p class="continue">明细续下页，本页不重复计合计。</p>`}</article>`);
  }
 }
 const sheets:string[]=[];for(let i=0;i<pages.length;i+=options.paper==='A4'?2:1)sheets.push(`<section class="paper">${pages.slice(i,i+(options.paper==='A4'?2:1)).join('')}</section>`);
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>缴费通知单</title><style>@page {size:${options.paper==='A4'?'A4 landscape':'A5 portrait'};margin:0}*{box-sizing:border-box}body{margin:0;background:white;color:#172033;font:8.6pt/1.45 'Microsoft YaHei','PingFang SC',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}.paper{width:${options.paper==='A4'?'297':'148'}mm;height:210mm;padding:9mm;break-after:page;overflow:hidden;${options.paper==='A4'?'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10mm;':''}}.paper:last-child{break-after:auto}.notice{min-width:0;height:100%;display:flex;flex-direction:column;break-inside:avoid}.hd{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}.hd .org b{font-size:12pt;letter-spacing:.02em}.hd .org small{display:block;font-size:6.6pt;color:#9099ad;margin-top:1mm}.hd .doc{text-align:right;font-size:6.8pt;color:#55607a;line-height:1.5}.hd .doc span{display:inline-block;font-size:8pt;color:#2d4e73;border:1px solid #cfdcec;background:#eef3f9;border-radius:3px;padding:.6mm 2mm;letter-spacing:.08em}.hd .doc small{display:block;margin-top:.8mm}.rule{height:1.6pt;background:#2d4e73;margin-top:2mm}.title{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:1.2mm}.title h1{font-size:11.6pt;letter-spacing:.08em;margin:0;white-space:nowrap}.title .sub{font-size:7pt;color:#55607a;text-align:right;line-height:1.5}.title .sub b{color:#172033}.facts{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;border:1px solid #e4e8ef;border-radius:3px;margin-top:1.4mm}.facts div{padding:1.2mm 2mm;border-right:1px solid #eef1f6}.facts div:last-child{border-right:0}.facts span{display:block;font-size:6.4pt;color:#9099ad}.facts b{display:block;font-size:8.6pt;margin-top:.4mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lead{margin:1mm 0 0;font-size:7.4pt;color:#55607a}table{width:100%;border-collapse:collapse;margin-top:1.6mm}th,td{padding:0.7mm 2mm;border-bottom:1px solid #eef1f6;text-align:left;font-size:8.2pt}th{font-size:6.8pt;color:#55607a;background:#f4f7fb;border-top:1.2pt solid #172033;border-bottom:1px solid #e4e8ef}.money{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.total{display:flex;align-items:baseline;justify-content:space-between;margin-top:1.4mm;padding:1.6mm 2mm;background:#eef3f9;border-top:1.4pt solid #2d4e73;font-size:8.6pt}.total b{font-size:14pt;color:#2d4e73}.upper{margin-top:1.2mm;font-size:6.8pt;color:#9099ad}.upper b{color:#172033;font-size:8pt;letter-spacing:.04em}.pay{display:grid;grid-template-columns:repeat(3,1fr);gap:1.6mm;margin-top:1.2mm}.pay div{border:1px solid #e4e8ef;border-radius:3px;padding:1.4mm 1.8mm}.pay b{display:block;font-size:7.4pt;color:#3a648f;margin-bottom:.8mm}.pay small{font-size:6.4pt;color:#55607a;line-height:1.5}.callout{margin-top:1.2mm;border-left:2pt solid #2d4e73;background:#eef3f9;padding:1.4mm 2mm;border-radius:0 3px 3px 0}.callout b{font-size:7.2pt;color:#2d4e73;letter-spacing:.08em}.callout p{margin:.6mm 0 0;font-size:7pt;color:#55607a}.notes{margin-top:1mm;font-size:6.4pt;color:#9099ad}.notes p{margin:.4mm 0}.continue{font-size:7pt;color:#9099ad}footer{margin-top:auto;padding-top:1.4mm;border-top:1px solid #e4e8ef;display:flex;justify-content:space-between;gap:6mm;font-size:6.2pt;color:#9099ad}.signature{text-align:right}.paper{position:relative}@media screen{body{background:#eee;padding:16px}.paper{margin:0 auto 16px;background:white;box-shadow:0 1px 6px #0002}}</style></head><body>${sheets.join('')}</body></html>`;
}
export async function printNotices(notices:Notice[],options:{queriedAt:string;batchNo:string;paper:'A5'|'A4'},isCurrent:()=>boolean=()=>true,beforePrint?:(pageCount:number)=>Promise<unknown>){
 if(!isCurrent())return;
 const frame=document.createElement('iframe');frame.title='缴费通知单打印';frame.style.cssText='position:fixed;left:-20000px;top:0;width:800px;height:1000px;border:0';document.body.appendChild(frame);
 const doc=frame.contentDocument;if(!doc){frame.remove();throw new Error('打印文档未能打开，请重试')}
 doc.open();doc.write(renderNoticeDocument(notices,options));doc.close();await doc.fonts.ready;await new Promise(r=>setTimeout(r,250));
 if(!isCurrent()){frame.remove();return}
 try{if(beforePrint)await beforePrint(doc.querySelectorAll('section.paper').length)}catch(e){frame.remove();throw e}
 if(!isCurrent()){frame.remove();return}
 const close=()=>{frame.remove();window.removeEventListener('afterprint',close)};frame.contentWindow!.addEventListener('afterprint',close,{once:true});setTimeout(()=>{if(frame.isConnected)frame.remove()},300000);frame.contentWindow!.focus();frame.contentWindow!.print();
}
