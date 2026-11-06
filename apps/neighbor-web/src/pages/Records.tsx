import {useEffect,useRef,useState} from 'react';
import {request} from '@pms/api-client';import {useNavigate} from 'react-router-dom';import {useSession} from '@/lib/auth';
import {dayjs,money,payLabel} from '@/lib/format';import DateInput from '@/components/DateInput';import Icon from '@/components/Icon';
interface Txn{id:number;txnNo:string;serviceType:string;status:string;amountCents:number;paymentMethod:string|null;createdAt:string;externalSyncStatus:string;address?:string;plateNo?:string;cashier?:string;}
interface Ledger{rows:Txn[];total:number;page:number;pageSize:number;summary:{paidCents:number;refundedCents:number;netCents:number;freeCount:number;syncedCount:number};}
type Filter=''|'parking_monthly'|'access_card'|'mis_property'|'mis_berth'|'free'|'refunded';
const LABEL:Record<string,string>={parking_monthly:'停车续期',access_card:'门禁卡',mis_property:'物业费',mis_berth:'泊位费'};
const syncLabel=(s:string)=>({synced:'已写入并回读',mis_queued:'等待MIS销账',mis_running:'MIS销账中',mis_checking:'原凭证核验中',mis_unknown:'结果未知 · 先核原单',mis_manual:'原单待人工核查',mis_failed:'MIS未完成',queued:'等待执行',running:'执行中',retry:'等待重试',failed:'执行失败',manual:'需人工',dry_run:'演练未写入',mocked:'未接自动同步',review:'待审批',awaiting_docs:'等待资料',rejected:'审批未通过'} as Record<string,string>)[s]||'核验状态未确认';
/** PMS收款事实与源库执行状态分开；统计来自完整服务端筛选，不累计本页。 */
export default function Records(){
 const nav=useNavigate(),session=useSession();const [filter,setFilter]=useState<Filter>(''),[draft,setDraft]=useState(''),[term,setTerm]=useState(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(20),[from,setFrom]=useState(''),[to,setTo]=useState(''),[revision,setRevision]=useState(0);
 const [result,setResult]=useState<{key:string;data:Ledger}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null),[loading,setLoading]=useState(false);
 const key=JSON.stringify([session.generation,session.user?.id,session.actingTenant?.id,session.access?.scopeAll,session.access?.communityIds,filter,term,page,pageSize,from,to,revision]);
 const generation=useRef({key,n:0});if(generation.current.key!==key)generation.current={key,n:generation.current.n+1};
 useEffect(()=>{
  const n=++generation.current.n;let alive=true;const valid=()=>alive&&generation.current.key===key&&generation.current.n===n;
  setLoading(true);setFailure(null);
  request<Ledger>({url:'/business/transaction-ledger',query:{page,pageSize,q:term||undefined,from:from||undefined,to:to||undefined,...(filter==='free'?{kind:'free'}:filter==='refunded'?{status:'refunded'}:filter?{serviceType:filter}:{})}})
   .then(data=>{if(!valid())return;if(!Array.isArray(data.rows)||!Number.isSafeInteger(data.total)||!Number.isSafeInteger(data.summary?.netCents))throw Error('bad contract');setResult({key,data});if(data.page!==page)setPage(data.page);})
   .catch(()=>{if(valid()){setResult(null);setFailure({key,message:'办理记录读取失败，条件已保留，请重试'});}})
   .finally(()=>{if(valid())setLoading(false)});
  return()=>{alive=false};
 },[key]);
 const data=result?.key===key?result.data:null,error=failure?.key===key?failure.message:'';
 const submit=()=>{setTerm(draft.trim());setPage(1);setRevision(v=>v+1)};
 const filters:Array<[Filter,string]>=[['','全部'],['parking_monthly','停车'],['access_card','门禁卡'],['mis_property','物业费'],['mis_berth','泊位费'],['free','免费'],['refunded','已退款']];
 return <>
  <div className="ph"><div><h1>办理记录</h1><p>PMS收款事实 · 外部销账结果单独核验 · 数据范围：{session.access?.scopeAll?'全部管理处':`${session.access?.communityIds?.length||0}个授权小区`}</p></div><button className="btn" onClick={()=>nav('/fees')}><Icon name="receipt"/>收费流水</button></div>
  <div className="chips" style={{display:'flex',flexWrap:'nowrap',overflowX:'auto',marginBottom:12}}>{filters.map(([k,label])=><button className={`chip ${filter===k?'on':''}`} key={k} onClick={()=>{setFilter(k);setPage(1)}}>{label}</button>)}</div>
  <div className="card" style={{padding:14,marginBottom:12}}><div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
   <input className="in" aria-label="办理记录搜索" placeholder="房号 / 车牌 / 收款人 / 单号" style={{flex:'1 1 260px',minWidth:0}} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')submit()}}/>
   <label>收款日期 <DateInput value={from} onChange={e=>{setFrom(e.target.value);setPage(1)}} style={{width:160}}/></label><span>至</span><DateInput aria-label="结束收款日期" value={to} onChange={e=>{setTo(e.target.value);setPage(1)}} style={{width:160}}/>
   <button className="btn p" onClick={submit}>查询</button>
  </div><div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:12}}><span>筛选实收 <b>{data?money(data.summary.paidCents/100):'—'}</b></span><span>筛选净额 <b data-testid="ledger-net">{data?money(data.summary.netCents/100):'—'}</b></span><span>{data?`共${data.total}笔 · 免费${data.summary.freeCount}笔`:'汇总未获取'}</span></div></div>
  {error?<div role="alert" className="note" style={{color:'var(--dang)'}}>{error}<button className="btn" onClick={()=>setRevision(v=>v+1)}>重试</button></div>:null}
  {loading?<div role="status" className="note"><span className="spin"/>正在读取办理记录与完整筛选汇总…</div>:null}
  <div className="card"><div className="t-scroll" style={{overflowX:'auto',maxWidth:'100%'}}><table className="tbl" style={{minWidth:920}}><thead><tr><th>业务 / 对象</th><th>实收金额</th><th>收款方式</th><th>收款时间</th><th>收款人</th><th>收款事实</th><th>外部核验</th></tr></thead><tbody>
   {data?.rows.map(t=><tr key={t.id}><td><b>{LABEL[t.serviceType]||'其他业务'} {t.plateNo||t.address||'—'}</b><div className="muted" style={{fontSize:13}}>单号 {t.txnNo}</div></td><td className="nw"><b className="money">{money(t.amountCents/100)}</b></td><td className="nw">{payLabel(t.paymentMethod)}</td><td className="nw">{dayjs(t.createdAt).format('YYYY-MM-DD HH:mm')}</td><td className="nw">{t.cashier||'未记录'}</td><td className="nw">{t.status==='paid'?'已登记收款':t.status==='refunded'?'已退款':t.status==='cancelled'?'已取消':'待核实'}</td><td><span className={`tag ${t.externalSyncStatus==='synced'?'ok':/unknown|failed|manual/.test(t.externalSyncStatus)?'warn':'mute'}`}>{syncLabel(t.externalSyncStatus)}</span></td></tr>)}
   {data&&!data.rows.length?<tr><td colSpan={7} className="muted" style={{padding:28,textAlign:'center'}}>没有匹配的办理记录</td></tr>:null}
  </tbody></table></div></div>
  <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginTop:12}}><label>每页 <select className="in" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1)}}>{[20,50,100].map(n=><option key={n} value={n}>{n}条</option>)}</select></label><span>{data?`第${data.page}页 / 共${Math.max(1,Math.ceil(data.total/pageSize))}页`:'页数未获取'}</span><button className="btn" disabled={loading||!data||page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button><button className="btn" disabled={loading||!data||page*pageSize>=data.total} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
  <p className="muted">收款已登记不代表MIS/停车/门禁已完成。结果未知时先核对原办理单，不要重新收款。</p>
 </>;
}
