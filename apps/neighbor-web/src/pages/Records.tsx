import { formatBeijingDateTime } from '@pms/shared-types';
import {useEffect,useRef,useState} from 'react';
import {request} from '@pms/api-client';import {useNavigate} from 'react-router-dom';import {useSession} from '@/lib/auth';
import {dayjs,money,payLabel} from '@/lib/format';import DateInput from '@/components/DateInput';import Icon from '@/components/Icon';
import '@/styles/records-detail.css';

/** 后端 detail（api-followups 新增）：业务明细；未上线时下面所有字段都按可选处理。 */
interface ParkingOperationDetail {
  key?:string|null;systemLabel?:string|null;action?:string|null;previousEndDate?:string|null;targetEndDate?:string|null;
  status?:string|null;operationId?:number|null;note?:string|null;plannedPreviousEndDate?:string|null;plannedTargetEndDate?:string|null;
}
interface TxnDetail {
  parkingOperations?:ParkingOperationDetail[];
  execution?:{status?:string|null;mode?:string|null;finishedAt?:string|null;lastError?:string|null;operationId?:number|null;manualDone?:{at?:string|null;note?:string|null}|null}|null;
  plateNo?: string | null; periodFrom?: string | null; periodTo?: string | null;
  amountCents?: number | null; paidAt?: string | null;
  operatorName?: string | null; paymentMethod?: string | null;
  serviceType?: string | null; extra?: Record<string, unknown> | null;
}
interface Txn{id:number;txnNo:string;serviceType:string;status:string;amountCents:number;paymentMethod:string|null;createdAt:string;externalSyncStatus:string;address?:string;plateNo?:string;cashier?:string;detail?:TxnDetail|null;}
interface Ledger{rows:Txn[];total:number;page:number;pageSize:number;summary:{paidCents:number;refundedCents:number;netCents:number;freeCount:number;syncedCount:number};}
type Filter=''|'parking_monthly'|'access_card'|'mis_property'|'mis_berth'|'free'|'refunded';
type DetailItem={label:string;value:string};
const LABEL:Record<string,string>={parking_monthly:'停车续期',access_card:'门禁卡',mis_property:'物业费',mis_berth:'泊位费'};
const syncLabel=(s:string)=>({synced:'已写入并回读',mis_queued:'等待MIS销账',mis_running:'MIS销账中',mis_checking:'原凭证核验中',mis_unknown:'结果未知 · 先核原单',mis_manual:'原单待人工核查',mis_failed:'MIS未完成',queued:'等待执行',running:'执行中',retry:'等待重试',failed:'执行失败',manual:'需人工',dry_run:'演练未写入',mocked:'未接自动同步',review:'待审批',awaiting_docs:'等待资料',rejected:'审批未通过'} as Record<string,string>)[s]||'核验状态未确认';
/** 普通用户只展示业务白名单字段，不倾倒内部键名/对象。执行证据另按系统展示。 */
const EXTRA_LABEL:Record<string,string>={
  plateNo:'车牌', periodFrom:'原到期时间', periodTo:'新到期时间', spaceNo:'车位编号', parkingSpaceNo:'车位编号', berthNo:'车位编号', parkingNo:'车位编号',
  cardNo:'卡号', icCardNo:'IC 卡号', wgCardNo:'WG 卡号', cardNumber:'卡号', validTo:'有效期', endDate:'有效期',
  operatorName:'操作人', paymentMethod:'收款方式', amountCents:'金额', paidAt:'收款时间', serviceType:'业务类型',
  communityName:'小区', buildingNo:'楼栋', roomNo:'房号', reason:'原因', note:'备注', quantity:'数量', months:'月数', remark:'说明',
  vehicleClass:'计费类别',ruleName:'缴费规则',periodStart:'计价起始日',periodEnd:'计价测算到期日',newVehicle:'办理事项',cards:'门禁卡号',
};
const CURRENCY_KEYS=new Set(['amountCents','paidCents','refundedCents','netCents']);
const DATE_KEYS=new Set(['paidAt','createdAt','periodFrom','periodTo','validTo','endDate']);
const blank=(v:unknown)=>v===null||v===undefined||v===''?'—':String(v);
function detailValue(key:string,value:unknown):string{
  if(value===null||value===undefined||value==='')return '—';
  if(CURRENCY_KEYS.has(key)&&Number.isFinite(Number(value)))return money(Number(value)/100);
  if(DATE_KEYS.has(key)){
    const text=String(value);
    const parsed=dayjs(text);
    return parsed.isValid()?(/^\d{4}-\d{2}-\d{2}$/.test(text)?text:formatBeijingDateTime(text,'YYYY-MM-DD HH:mm')):text;
  }
  if(key==='serviceType')return LABEL[String(value)]||String(value);
  if(key==='newVehicle')return value===true?'新办车牌':'停车续期';
  if(key==='cards'&&Array.isArray(value))return value.map(c=>c&&typeof c.cardNo==='string'?c.cardNo:'').filter(Boolean).join('、')||'未记录卡号';
  if(typeof value==='object')return '—';
  return String(value);
}
function payText(value:string|null|undefined){const text=blank(value);return text==='—'?'—':payLabel(text);}
/** 收款/计价信息与停车系统执行记录分开，未知内部字段不直接面向用户。 */
function detailItems(t:Txn):{items:DetailItem[];extra:Array<DetailItem&{key:string}>}{
  const d=t.detail||{};
  const extra=d.extra&&typeof d.extra==='object'?d.extra:{};
  const used=new Set<string>();
  const pick=(key:string,label:string,value:unknown)=>{used.add(key);return {label,value:detailValue(key,value)};};
  const items:DetailItem[]=[];
  if(t.serviceType==='parking_monthly'){
    items.push(pick('plateNo','车牌',d.plateNo??t.plateNo));
    items.push(pick('periodFrom','原到期日（收款快照）',d.periodFrom));
    items.push(pick('periodTo','办理目标到期日',d.periodTo));
    items.push({label:'关联地址',value:blank(t.address)});
    const space=extra.spaceNo??extra.parkingSpaceNo??extra.berthNo??extra.parkingNo;
    if(space)items.push(pick('spaceNo','车位编号',space));
  }else if(t.serviceType==='access_card'){
    items.push(pick('cardNo','卡号',extra.cardNo??extra.icCardNo??extra.wgCardNo??extra.cardNumber));
    items.push(pick('validTo','有效期',extra.validTo??extra.endDate??d.periodTo));
  }
  items.push({label:'业务类型',value:LABEL[d.serviceType||t.serviceType]||blank(d.serviceType||t.serviceType)});
  items.push({label:'实收金额',value:detailValue('amountCents',d.amountCents??t.amountCents)});
  items.push({label:'收款方式',value:payText(d.paymentMethod??t.paymentMethod)});
  items.push({label:'操作人',value:blank(d.operatorName??t.cashier)});
  items.push({label:'收款时间',value:detailValue('paidAt',d.paidAt??t.createdAt)});
  const extraItems=Object.entries(extra)
    .filter(([key,value])=>!used.has(key)&&!!EXTRA_LABEL[key]&&value!==null&&value!==undefined&&value!==''&&(typeof value!=='object'||key==='cards'))
    .map(([key,value])=>({key,label:EXTRA_LABEL[key],value:detailValue(key,value)}));
  return {items,extra:extraItems};
}
const stepLabel=(status?:string|null)=>({pending:'等待执行',waiting:'等待执行回执',done:'步骤已完成',manual:'需人工核查',failed:'执行失败',dry_run:'演练未写入'} as Record<string,string>)[status||'']||'未记录分步结果';
const operationLabel=(action?:string|null)=>({check:'车牌查重',register:'新增车辆登记',renew:'延长停车有效期'} as Record<string,string>)[action||'']||'停车业务办理';
const txnSyncLabel=(t:Txn)=>t.serviceType==='parking_monthly'?(t.detail?.execution?.manualDone?'人工登记办结':t.externalSyncStatus==='synced'?'流程已标记完成':syncLabel(t.externalSyncStatus)):syncLabel(t.externalSyncStatus);
function renderParkingOperations(t:Txn){
 if(t.serviceType!=='parking_monthly')return null;
 const d=t.detail||{},extra=d.extra||{},execution=d.execution;
 const legacy=Array.isArray(extra.parkingSystems)?extra.parkingSystems.filter(s=>s&&typeof s==='object').map((s:any)=>({systemLabel:typeof s.label==='string'?s.label:s.database==='parking1'?'一期停车系统':s.database==='parking2'?'二期停车系统':'停车系统（名称未记录）',previousEndDate:s.previousEndDate,targetEndDate:d.periodTo,status:'unrecorded',action:extra.newVehicle?'register':'renew'})):[];
 const operations:ParkingOperationDetail[]=Array.isArray(d.parkingOperations)&&d.parkingOperations.length?d.parkingOperations:legacy;
 const measured=typeof extra.periodEnd==='string'?extra.periodEnd.slice(0,10):null;
 const mismatch=measured&&d.periodTo&&measured!==d.periodTo.slice(0,10);
 return <section className="rec-detail-extra" aria-label="车辆系统操作">
  <div className="rec-operation-heading"><b>车辆系统操作</b><span className="tag mute">{txnSyncLabel(t)}</span></div>
  {mismatch?<p className="rec-operation-warning" role="note">日期不一致：办理目标到期日 {d.periodTo}，计价测算到期日 {measured}。请核对原办理单及系统记录，不要据此重复收款或重办。</p>:null}
  <div className="rec-operation-list">{operations.map((op,i)=><article className="rec-operation" key={`${op.key||'system'}:${i}`}>
   <div className="rec-operation-heading"><b>{blank(op.systemLabel)}</b><span className={`tag ${/failed|manual/.test(op.status||'')?'warn':'mute'}`}>{stepLabel(op.status)}</span></div>
   <div className="rec-detail-grid">
    <div className="rec-detail-item"><span>办理动作</span><b>{operationLabel(op.action)}</b></div>
    {op.operationId?<div className="rec-detail-item"><span>关联任务</span><b>#{op.operationId}</b></div>:null}
    {op.plannedPreviousEndDate?<div className="rec-detail-item"><span>执行计划原到期日</span><b>{op.plannedPreviousEndDate}</b></div>:null}
    {op.plannedTargetEndDate?<div className="rec-detail-item"><span>执行计划目标到期日</span><b>{op.plannedTargetEndDate}</b></div>:null}
    {op.action!=='check'?<><div className="rec-detail-item"><span>原到期日（收款快照）</span><b>{blank(op.previousEndDate)}</b></div><div className="rec-detail-item"><span>办理目标到期日</span><b>{blank(op.targetEndDate)}</b></div></>:null}
   </div>
   <p className="rec-operation-note">执行记录说明：{op.note||'本单未保存该系统的分步执行说明，不能据总状态推定已写入或回读。'}</p>
  </article>)}</div>
  {!operations.length?<p className="muted">本单未保存停车系统名称或分步结果，请核对原办理单与停车系统记录。</p>:null}
  {execution?.operationId?<p className="rec-operation-note">本单关联任务：#{execution.operationId}（不代表完整操作历史）</p>:null}
  {execution?.finishedAt?<p className="rec-operation-note">本轮处理结束：{detailValue('paidAt',execution.finishedAt)}（不等于执行成功）</p>:null}
  {execution?.lastError?<p className="rec-operation-warning">未完成原因：{execution.lastError}</p>:null}
  {execution?.manualDone?<p className="rec-operation-note">人工登记办结：{execution.manualDone.note} {execution.manualDone.at?`（${detailValue('paidAt',execution.manualDone.at)}）`:''}；此为人工登记，不作为自动回读或设备确认凭据。</p>:null}
  <p className="rec-operation-note">以上为本办理单保存的系统执行记录，不是该车全部操作历史。步骤完成不等于设备已生效；现场通行：未验证。</p>
 </section>;
}
/** PMS收款事实与源库执行状态分开；统计来自完整服务端筛选，不累计本页。 */
export default function Records(){
 const nav=useNavigate(),session=useSession();const [filter,setFilter]=useState<Filter>(''),[draft,setDraft]=useState(''),[term,setTerm]=useState(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(20),[from,setFrom]=useState(''),[to,setTo]=useState(''),[revision,setRevision]=useState(0);
 const [result,setResult]=useState<{key:string;data:Ledger}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null),[loading,setLoading]=useState(false);
 const [expanded,setExpanded]=useState<number[]>([]);
 const key=JSON.stringify([session.generation,session.user?.id,session.actingTenant?.id,session.access?.scopeAll,session.access?.communityIds,filter,term,page,pageSize,from,to,revision]);
 const generation=useRef({key,n:0});if(generation.current.key!==key)generation.current={key,n:generation.current.n+1};
 useEffect(()=>{setExpanded([])},[key]);
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
 const toggle=(id:number)=>setExpanded((prev)=>prev.includes(id)?prev.filter((value)=>value!==id):[...prev,id]);
 const filters:Array<[Filter,string]>=[['','全部'],['parking_monthly','停车'],['access_card','门禁卡'],['mis_property','物业费'],['mis_berth','泊位费'],['free','免费'],['refunded','已退款']];
 const renderDetail=(t:Txn)=>{
  const {items,extra}=detailItems(t);
  return (
   <div className="rec-detail">
    <div className="rec-detail-head"><b>业务明细</b><span className="muted">单号 {t.txnNo}</span></div>
    <div className="rec-detail-grid">
     {items.map((item)=><div className="rec-detail-item" key={item.label}><span>{item.label}</span><b>{item.value}</b></div>)}
    </div>
    {renderParkingOperations(t)}
     {extra.length?(
     <div className="rec-detail-extra">
      <div className="rec-detail-sub">计价与补充信息</div>
      <div className="rec-detail-grid">
       {extra.map((item)=><div className="rec-detail-item" key={item.key}><span>{item.label}</span><b>{item.value}</b></div>)}
      </div>
     </div>
    ):null}
   </div>
  );
 };
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
  <div className="card"><div className="t-scroll" style={{overflowX:'auto',maxWidth:'100%'}}><table className="tbl rec-table" style={{minWidth:1000}}><thead><tr><th>业务 / 对象</th><th>实收金额</th><th>收款方式</th><th>收款时间</th><th>收款人</th><th>收款事实</th><th>外部核验</th><th style={{width:92}}>明细</th></tr></thead><tbody>
   {data?.rows.map(t=>{
    const open=expanded.includes(t.id);
    return [
     <tr key={t.id} className={`rec-row${open?' open':''}`} onClick={()=>toggle(t.id)}>
      <td><b>{LABEL[t.serviceType]||'其他业务'} {t.plateNo||t.address||'—'}</b><div className="muted" style={{fontSize:13}}>单号 {t.txnNo}</div></td>
      <td className="nw"><b className="money">{money(t.amountCents/100)}</b></td>
      <td className="nw">{payText(t.detail?.paymentMethod??t.paymentMethod)}</td>
      <td className="nw">{formatBeijingDateTime(t.createdAt, 'YYYY-MM-DD HH:mm')}</td>
      <td className="nw">{blank(t.detail?.operatorName??t.cashier)}</td>
      <td className="nw">{t.status==='paid'?'已登记收款':t.status==='refunded'?'已退款':t.status==='cancelled'?'已取消':'待核实'}</td>
      <td><span className={`tag ${t.externalSyncStatus==='synced'?'ok':/unknown|failed|manual/.test(t.externalSyncStatus)?'warn':'mute'}`}>{txnSyncLabel(t)}</span></td>
      <td className="nw"><button type="button" className="btn sm rec-detail-btn" aria-expanded={open} onClick={(e)=>{e.stopPropagation();toggle(t.id)}}>{open?'收起':'明细'}</button></td>
     </tr>,
     open?<tr key={`${t.id}-detail`} className="rec-detail-row"><td colSpan={8} className="rec-detail-cell">{renderDetail(t)}</td></tr>:null,
    ];
   })}
   {data&&!data.rows.length?<tr><td colSpan={8} className="muted" style={{padding:28,textAlign:'center'}}>没有匹配的办理记录</td></tr>:null}
  </tbody></table></div></div>
  <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginTop:12}}><label>每页 <select className="in" value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(1)}}>{[20,50,100].map(n=><option key={n} value={n}>{n}条</option>)}</select></label><span>{data?`第${data.page}页 / 共${Math.max(1,Math.ceil(data.total/pageSize))}页`:'页数未获取'}</span><button className="btn" disabled={loading||!data||page<=1} onClick={()=>setPage(p=>p-1)}>上一页</button><button className="btn" disabled={loading||!data||page*pageSize>=data.total} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
  <p className="muted">收款已登记不代表MIS/停车/门禁已完成。结果未知时先核对原办理单，不要重新收款。</p>
 </>;
}
