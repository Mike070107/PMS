import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { ErrorNote, Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import DateInput from '@/components/DateInput';
import { cents, chinaDate } from '@/lib/residential-bills';
type PromiseRow={id:number;houseKey:string;promisedDate:string;promisedCents:string;fulfilled:boolean;overdue:boolean};
type Hold={id:number;houseKey:string;reason:string;until:string};
type Event={id:number;houseKey:string;action:string;note:string;createdAt:string;createdBy:number};
type LargeInactive={houseKey:string;address:string;amountCents:number;lastContactAt:string|null;days:number|null;never:boolean};
type FollowupStatus='all'|'never'|'overdue'|'contacted';
type Sort='amount'|'recent';
type QueueRow={houseKey:string;phone?:string|null;phoneMasked?:string;address:string;ownerName:string;amountCents:number;lastContactAt:string|null;days:number|null;never:boolean;lastAction:'phone'|'promise'|'hold'|null;lastNote:string;contactCount:number;followupStatus:'never'|'overdue'|'contacted'};
type Stats={avgAmountCents:number;hitCount:number;hitAmountCents:number;thresholdCents:number;inactiveDays:number;scanned?:number;neverCount?:number;overdueCount?:number;contactedCount?:number};
type Rule={amountCents:number;inactiveDays:number;enabled:boolean};
type Data={followupHouseholds:number;promises:PromiseRow[];holds:Hold[];events:Event[];rows?:QueueRow[];total?:number;totalAmountCents?:number;page?:number;pageSize?:number;largeInactive?:LargeInactive[];stats?:Stats;rule?:Rule};
const Context=createContext<{data:Data|null;editable:boolean;open:(key:string)=>void}>({data:null,editable:false,open:()=>{}});
const reasons:Record<string,string>={dispute:'费用争议',request:'住户申请',complaint:'投诉处理中'};
const actionNames:Record<string,string>={phone:'电话',promise:'承诺付款',hold:'冻结'};
const statusOptions:Array<[FollowupStatus,string]>=[['all','全部'],['never','从未跟进'],['overdue','超期未跟进'],['contacted','已跟进']];
const PAGE_SIZE=20,defaultRule:Rule={amountCents:180000,inactiveDays:7,enabled:true},emptyStats:Stats={avgAmountCents:0,hitCount:0,hitAmountCents:0,thresholdCents:0,inactiveDays:0};
function friendly(e:unknown){return e instanceof Error&&/[\u4e00-\u9fff]/.test(e.message)?e.message:'跟进查询未完成，可重试'}
function dayText(row:QueueRow){if(row.never)return '从未';const days=row.days??0;return days<=0?'今天':days+' 天前'}
function dateText(iso:string|null){if(!iso)return '';const d=new Date(iso);return Number.isFinite(d.getTime())?d.toLocaleDateString('zh-CN'):''}
export function FollowupCell({houseKey}:{houseKey:string}){
  const c=useContext(Context),p=c.data?.promises.filter(p=>p.houseKey===houseKey&&!p.fulfilled)||[],h=c.data?.holds.filter(h=>h.houseKey===houseKey)||[];
  return <details className="rb-more" onClick={e=>{const d=e.currentTarget;if(d.open)return;const r=d.getBoundingClientRect(),m=d.querySelector('.rb-more-menu') as HTMLElement|null;if(!m)return;const below=r.bottom+6,menuHeight=240;m.style.position='fixed';m.style.top=(below+menuHeight>window.innerHeight?Math.max(8,r.top-menuHeight):below)+'px';m.style.right=Math.max(12,window.innerWidth-r.right)+'px'}}>
    <summary className="rb-more-btn" title="更多跟进操作" aria-label="更多跟进操作">⋯</summary>
    <div className="rb-more-menu">
      {!!p.length&&<div className="rb-more-tags">{p.map(p=><small className={'rb-sub '+(p.overdue?'rb-due':'')} key={p.id}>{p.overdue?'承诺已到期':'承诺至 '+p.promisedDate} · ¥{cents(Number(p.promisedCents))}</small>)}</div>}
      {!!h.length&&<div className="rb-more-tags">{h.map(h=><small className="rb-sub" key={h.id}>冻结：{reasons[h.reason]} · 至{h.until}</small>)}</div>}
      <button className="btn sm" onClick={ev=>{c.open(houseKey);const d=ev.currentTarget.closest('details') as HTMLDetailsElement|null;if(d)d.open=false}}>{c.editable?'记电话 / 承诺 / 冻结':'查看跟进'}</button>
    </div>
  </details>;
}
export function FollowupTodayMetric(){
  const c=useContext(Context);
  return <><b>{c.data?c.data.followupHouseholds:'—'}</b><em>{c.data?'个责任对象':'读取中'}</em></>;
}
export default function CollectionFollowups({communityId,version,editable,onChanged,children}:{communityId?:number;version:string;editable:boolean;onChanged:()=>void;children:React.ReactNode}){
 const [query,setQuery]=useState(''),[keyword,setKeyword]=useState('');
 const [status,setStatus]=useState<FollowupStatus>('all'),[sort,setSort]=useState<Sort>('amount');
 const [rows,setRows]=useState<QueueRow[]>([]),[meta,setMeta]=useState<{total:number;amountCents:number;stats:Stats;rule:Rule}|null>(null);
 const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(false),[loadingMore,setLoadingMore]=useState(false),[failure,setFailure]=useState('');
 const [page,setPage]=useState(1),[rev,setRev]=useState(0),[selected,setSelected]=useState('');
 const [action,setAction]=useState('phone'),[note,setNote]=useState(''),[date,setDate]=useState(chinaDate()),[amount,setAmount]=useState(''),[reason,setReason]=useState('dispute'),[recordId,setRecordId]=useState<number|undefined>(),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
 const [ruleOpen,setRuleOpen]=useState(false),[ruleAmt,setRuleAmt]=useState(''),[ruleDays,setRuleDays]=useState('');
 const runRef=useRef(0),locked=useRef(false),requestKey=useRef('');
 useEffect(()=>{const timer=setTimeout(()=>setKeyword(query.trim()),300);return()=>clearTimeout(timer)},[query]);
 const key=JSON.stringify([communityId,version,rev,keyword,status,sort]);
 useEffect(()=>{
  const token=++runRef.current;let active=true;
  setLoading(true);setFailure('');setData(null);setRows([]);setPage(1);setSelected('');setSaving(false);locked.current=false;
  request<Data>({url:'/fees/mis/collections/followups',query:{communityId,status,sort,page:1,pageSize:PAGE_SIZE,q:keyword||undefined},timeout:30000}).then(r=>{
   if(!active||token!==runRef.current)return;
   setData(r);setRows(r.rows||[]);
   setMeta({total:r.total??(r.rows||[]).length,amountCents:r.totalAmountCents??(r.rows||[]).reduce((sum,row)=>sum+row.amountCents,0),stats:r.stats??emptyStats,rule:r.rule??defaultRule});
  }).catch(e=>{if(active&&token===runRef.current)setFailure(friendly(e))}).finally(()=>{if(active&&token===runRef.current)setLoading(false)});
  return()=>{active=false};
 },[key]);
 async function loadMore(){
  if(loading||loadingMore||!meta||rows.length>=meta.total)return;
  const token=runRef.current;setLoadingMore(true);setFailure('');
  try{const r=await request<Data>({url:'/fees/mis/collections/followups',query:{communityId,status,sort,page:page+1,pageSize:PAGE_SIZE,q:keyword||undefined},timeout:30000});if(token!==runRef.current)return;
   setRows(v=>[...v,...(r.rows||[])]);setPage(p=>p+1);
   setMeta(m=>m?{...m,total:r.total??m.total,amountCents:r.totalAmountCents??m.amountCents,stats:r.stats??m.stats,rule:r.rule??m.rule}:m);
  }catch(e){if(token===runRef.current)setFailure(friendly(e))}finally{if(token===runRef.current)setLoadingMore(false)}
 }
 function open(houseKey:string){setSelected(houseKey);setAction('phone');setNote('');setAmount('');setDate(chinaDate());setRecordId(undefined);setSaveError('');requestKey.current=crypto.randomUUID()}
 function change(){requestKey.current=crypto.randomUUID()}
 async function save(){if(!editable||locked.current||!selected)return;const token=runRef.current;let promisedCents:number|undefined;
  if(action==='promise'){if(!/^(?:\d+)(?:\.\d{1,2})?$/.test(amount.trim())){setSaveError('请输入明确的承诺金额，最多两位小数');return}promisedCents=Math.round(Number(amount)*100);if(!Number.isSafeInteger(promisedCents)||promisedCents<=0){setSaveError('承诺金额必须大于0');return}}
  if(!note.trim()){setSaveError('请填写跟进说明');return}locked.current=true;setSaving(true);setSaveError('');
  try{await request({method:'POST',url:'/fees/mis/collections/followups',data:{houseKey:selected,action,note:note.trim(),requestKey:requestKey.current,...(action==='promise'?{promisedDate:date,promisedCents}:{}),...(action==='hold'?{until:date,reason}:{}),...(action.startsWith('cancel_')?{recordId}: {})}});if(token!==runRef.current)return;toast('跟进已保存，MIS账务未改变');setSelected('');setRev(r=>r+1);onChanged()}catch(e){if(token===runRef.current)setSaveError(e instanceof Error&&/[\u4e00-\u9fff]/.test(e.message)?e.message:'保存失败，输入已保留，可重试原请求')}finally{if(token===runRef.current){locked.current=false;setSaving(false)}}}
 const promises=data?.promises.filter(p=>p.houseKey===selected)||[],holds=data?.holds.filter(h=>h.houseKey===selected)||[],events=data?.events.filter(e=>e.houseKey===selected)||[];
 const rule=meta?.rule??defaultRule;
 function openRule(){setRuleAmt(String(Math.round(rule.amountCents/100)));setRuleDays(String(rule.inactiveDays));setRuleOpen(v=>!v)}
 function emptyText(m:{total:number;stats:Stats;rule:Rule}){
  if(m.rule.enabled===false)return '催收规则已关闭，暂不生成跟进待办；可在「规则」里重新启用。';
  if(m.stats.hitCount)return `当前筛选没有记录；共 ${m.stats.hitCount} 户达到 ¥${(m.stats.thresholdCents/100).toFixed(0)} 门槛，切换到「全部」或清空搜索查看。`;
  return `当前门槛 ¥${(m.stats.thresholdCents/100).toFixed(0)}、${m.stats.inactiveDays} 天没有命中；平均待缴 ¥${(m.stats.avgAmountCents/100).toFixed(0)}，可下调门槛或缩短天数。`;
 }
 return <Context.Provider value={{data,editable,open}}>
  {children}
  <section className="rb-followup" aria-label="跟进提醒">
   <div className="rb-followup-head">
    <div className="rb-followup-head-main">
     <strong>跟进提醒</strong>
     <span className="rb-followup-count">{loading&&!meta?'跟进数据读取中…':`共 ${meta?.total??0} 户 · 金额 ¥${cents(meta?.amountCents??0)}`}</span>
    </div>
    <div className="rb-followup-head-tools">
     <label className="rb-search"><Icon name="search"/><input value={query} onChange={e=>setQuery(e.target.value)} aria-label="搜索跟进提醒" placeholder="搜索房号、地址或业主"/></label>
     <div className="chips rb-followup-chips">{statusOptions.map(([value,label])=><button type="button" key={value} className={'chip '+(status===value?'on':'')} aria-pressed={status===value} onClick={()=>setStatus(value)}>{label}</button>)}</div>
     <button className="btn sm" onClick={()=>setRev(r=>r+1)} disabled={loading}>刷新跟进</button>
     <button className="btn sm" onClick={openRule}>规则</button>
    </div>
   </div>
   {failure&&<ErrorNote>{failure}</ErrorNote>}
   {loading&&!rows.length?<p className="rb-note">跟进队列读取中…</p>:meta&&meta.total>0?<div className="card rb-followup-card">
    <div className="rb-followup-scroll">
     <table className="t rb-table rb-followup-table">
      <thead><tr>
       <th>房号 / 业主</th>
       <th className="rb-num" aria-sort={sort==='amount'?'descending':'none'}><button type="button" className={'rb-sortbtn'+(sort==='amount'?' on':'')} onClick={()=>setSort('amount')}>待缴金额<span aria-hidden="true">{sort==='amount'?' ↓':''}</span></button></th>
       <th aria-sort={sort==='recent'?'descending':'none'}><button type="button" className={'rb-sortbtn'+(sort==='recent'?' on':'')} onClick={()=>setSort('recent')}>上次跟进<span aria-hidden="true">{sort==='recent'?' ↓':''}</span></button></th>
       <th>电话</th>
       <th className="rb-num">次数</th>
       <th>最近结果</th>
       <th className="rb-ops-th">操作</th>
      </tr></thead>
      <tbody>{rows.map(row=><tr key={row.houseKey}>
       <td className="rb-followup-house"><b>{row.address}</b><small className="rb-sub">{row.ownerName||'业主未记录'}</small></td>
       <td className="rb-num"><strong className="rb-due">¥{cents(row.amountCents)}</strong></td>
       <td><span className={'rb-followup-state '+row.followupStatus}>{dayText(row)}</span>{!!row.lastContactAt&&<small className="rb-sub">{dateText(row.lastContactAt)}</small>}</td><td>{row.phone||row.phoneMasked||"—"}</td>
       <td className="rb-num">{row.contactCount}</td>
       <td>{row.lastAction?<><span className="rb-followup-action">{actionNames[row.lastAction]}</span><small className="rb-sub">{row.lastNote||'无备注'}</small></>:<small className="rb-sub">—</small>}</td>
       <td className="rb-ops-cell"><div className="rb-ops"><button className="btn sm" onClick={()=>open(row.houseKey)}>{editable?'跟进':'查看'}</button></div></td>
      </tr>)}</tbody>
     </table>
    </div>
    <div className="rb-followup-foot">
     <span>已显示 {rows.length} / {meta.total} 户 · 按{sort==='amount'?'金额':'最近跟进'}排序</span>
     {rows.length<meta.total&&<button className="btn sm" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'加载中…':'加载更多'}</button>}
    </div>
   </div>:!loading&&meta?<p className="rb-note">{emptyText(meta)}</p>:null}
   <p className="rb-note">只认电话 / 承诺 / 冻结三类人工跟进；打印与短信不计入。到期承诺按 MIS 原账单回款核对，同日先后无法判断。</p>
   <Sheet open={ruleOpen} onClose={()=>setRuleOpen(false)} title="催收规则" subtitle="改完立即生效，只影响之后的命中判断" width={520}><div className="rb-rule-form"><label>大额门槛（元）<input className="in" type="number" min="0" step="100" value={ruleAmt} onChange={e=>setRuleAmt(e.target.value)}/></label><label>多久没人工跟进算失联（天）<input className="in" type="number" min="1" max="365" value={ruleDays} onChange={e=>setRuleDays(e.target.value)}/></label><p className="rb-note">命中口径：待缴金额 ≥ 门槛，且从未人工跟进或距上次人工跟进 ≥ 天数。当前 ¥{Math.round(rule.amountCents/100)} · {rule.inactiveDays} 天。</p><button className="btn p" onClick={async()=>{try{await request({method:'PATCH',url:'/settings/collection-followup',data:{amountCents:Math.round(Number(ruleAmt)*100),inactiveDays:Number(ruleDays)}});toast('规则已保存');setRuleOpen(false);setRev(r=>r+1);onChanged()}catch(e){toast(e instanceof Error?e.message:'保存失败')}}}>保存规则</button></div></Sheet>
   <Sheet open={!!selected} onClose={()=>{if(!saving)setSelected('')}} title="住户催缴跟进" subtitle="不收款、不核销，不改变MIS原账；解除冻结须明确登记" width={680}>
  {editable&&<><div className="chips">{[['phone','记电话'],['promise','承诺付款'],['hold','争议 / 申请冻结']].map(([k,l])=><button key={k} className={'chip '+(action===k?'on':'')} onClick={()=>{setAction(k);setRecordId(undefined);change()}}>{l}</button>)}</div>{action==='promise'&&<label>承诺金额（元）<input className="in" aria-label="承诺金额" value={amount} onChange={e=>{setAmount(e.target.value);change()}} inputMode="decimal"/></label>}{(action==='promise'||action==='hold')&&<label>{action==='promise'?'承诺付款日':'冻结截止日（含）'}<DateInput type="date" className="in" value={date} onChange={e=>{setDate(e.target.value);change()}}/></label>}{action==='hold'&&<label>冻结原因<select className="in" value={reason} onChange={e=>{setReason(e.target.value);change()}}>{Object.entries(reasons).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label>}<label>跟进说明<textarea className="in" aria-label="跟进说明" maxLength={500} value={note} onChange={e=>{setNote(e.target.value);change()}}/></label>{saveError&&<ErrorNote>{saveError}</ErrorNote>}<button className="btn p" disabled={saving} onClick={()=>void save()}>{saving?'正在保存…':action==='cancel_hold'?'登记解除冻结':action==='cancel_promise'?'登记撤销承诺':'保存跟进'}</button></>}
  {promises.map(p=><div className="rb-notice-preview" key={p.id}>承诺 {p.promisedDate} · ¥{cents(Number(p.promisedCents))} · {p.fulfilled?'已回款':p.overdue?'承诺已到期':'待履约'}{editable&&<button className="btn sm" onClick={()=>{setAction('cancel_promise');setRecordId(p.id);setNote('');change()}}>撤销承诺</button>}</div>)}{holds.map(h=><div className="rb-notice-preview" key={h.id}>冻结至 {h.until} · {reasons[h.reason]}{editable&&<button className="btn sm" onClick={()=>{setAction('cancel_hold');setRecordId(h.id);setNote('');change()}}>解除冻结</button>}</div>)}<h3>责任对象跟进时间线</h3>{events.map(e=><div className="rb-notice-preview" key={e.id}><small>{new Date(e.createdAt).toLocaleString('zh-CN')} · 操作人#{e.createdBy}</small><p>{e.note}</p></div>)}{!events.length&&<p className="rb-note">当前没有跟进记录。</p>}</Sheet>
  </section>
 </Context.Provider>;
}
