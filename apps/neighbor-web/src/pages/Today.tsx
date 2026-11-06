import './erp-today.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs, request } from '@pms/api-client';
import { useSession } from '@/lib/auth';
import { dayjs, isActive, isOverdue, money, payLabel, stageOf } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';


interface Txn {
  id: number; txnNo: string; serviceType: string; status: string;
  amountCents: number; paymentMethod: string | null; createdAt: string;
}

const SERVICE_LABEL: Record<string, string> = { parking_monthly: '停车月租', access_card: '门禁卡', mis_property: '物业费', mis_berth: '泊位费' };
const svcIcon = (s: string): IconName => (s === 'parking_monthly' ? 'car' : s === 'access_card' ? 'key' : 'cash');

/**
 * 今日工作：PMS持久收款事实，包含MIS新办理的物业费/泊位费。
 * 分项收入、需要处理（工单待办 + 外部失败入口）、最近收款。
 * 不将源MIS原有历史缴费重复算入今日PMS收款。
 */
export default function Today() {
  const nav = useNavigate();
  const session = useSession();
  const [orders, setOrders] = useState<WorkOrderListItem[] | null>(null);
  const [ledger, setLedger] = useState<{key:string;data:{rows:Txn[];summary:{paidCents:number;refundedCents:number;paidCount:number;byService:Array<{serviceType:string;paidCents:number;paidCount:number}>}}}|null>(null);
  const [failure,setFailure]=useState<{key:string;message:string}|null>(null),[retry,setRetry]=useState(0);
  const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10),scope=JSON.stringify([session.generation,session.user?.id,session.actingTenant?.id,session.access?.scopeAll,session.access?.communityIds]),key=JSON.stringify([scope,date,retry]);
  const generation=useRef({key,n:0});if(generation.current.key!==key)generation.current={key,n:generation.current.n+1};
  const [ordersErr,setOrdersErr]=useState<{scope:string;message:string}|null>(null),[ordersRetry,setOrdersRetry]=useState(0);const ordersScope=useRef(scope);const visibleOrders=ordersScope.current===scope?orders:null,orderFailure=ordersErr?.scope===scope?ordersErr.message:'';
  useEffect(()=>{let alive=true;setOrders(null);setOrdersErr(null);repairs.list({scope:'all'}).then(r=>{if(alive){ordersScope.current=scope;setOrders(r)}}).catch(()=>{if(alive)setOrdersErr({scope,message:'工单读取失败，数量未获取，请重试'})});return()=>{alive=false}},[scope,ordersRetry]);
  useEffect(()=>{const n=++generation.current.n;let alive=true;const valid=()=>alive&&generation.current.key===key&&generation.current.n===n;setFailure(null);
    request<{rows:Txn[];summary:{paidCents:number;refundedCents:number;paidCount:number;byService:Array<{serviceType:string;paidCents:number;paidCount:number}>}}>({url:'/business/transaction-ledger',query:{from:date,to:date,page:1,pageSize:20}}).then(data=>{if(!valid())return;if(!Array.isArray(data.rows)||!Array.isArray(data.summary?.byService)||!Number.isSafeInteger(data.summary.paidCents))throw Error('bad contract');setLedger({key,data})}).catch(()=>{if(valid()){setLedger(null);setFailure({key,message:'今日流水读取失败，金额未获取，请重试'})}});return()=>{alive=false};
  },[key]);
  const data=ledger?.key===key?ledger.data:null,error=failure?.key===key?failure.message:'',txns=data?.rows??null;
  const paid=(txns??[]).filter(t=>t.status==='paid'),income=data?.summary.paidCents??0,refund=data?.summary.refundedCents??0;
  const bySvc=(s:string)=>({length:data?.summary.byService.find(r=>r.serviceType===s)?.paidCount??0});
  const parkSum=data?.summary.byService.find(r=>r.serviceType==='parking_monthly')?.paidCents??0,cardSum=data?.summary.byService.find(r=>r.serviceType==='access_card')?.paidCents??0;
  const propertySum=data?.summary.byService.filter(r=>['mis_property','mis_berth'].includes(r.serviceType)).reduce((s,r)=>s+r.paidCents,0)??0;
  const maxSum=Math.max(parkSum,cardSum,propertySum,1),amount=(n:number)=>data?money(n/100):'—';

  const repairStat = useMemo(() => {
    const list = visibleOrders ?? [];
    const active = list.filter((o) => isActive(o.status));
    const by = (s: WorkOrderStatus) => list.filter((o) => o.status === s).length;
    return {
      pending: list.filter((o) => stageOf(o) === WorkOrderStatus.CREATED).length,
      accepting: list.filter((o) => stageOf(o) === 'pending_accept').length,
      review: by(WorkOrderStatus.DONE_PENDING_REVIEW),
      material: by(WorkOrderStatus.WAITING_MATERIAL),
      overdue: active.filter((o) => isOverdue(o)).length,
      active: active.length,
    };
  }, [visibleOrders]);

  const name = session.user?.name || session.user?.loginAccount || '管理员';
  const officeName = session.actingOffice?.name || (session.access?.scopeAll ? '全部管理处' : '');

  // 财务失败/等待独立展示，不让工单请求隐藏流水重试入口。

  const todoRows: Array<{ icon: IconName; tone: string; t: string; d: string; n: number; to: string }> = [
    { icon: 'kanban', tone: 'red', t: '待派单工单', d: '没有自动派出去的，要办公室派', n: repairStat.pending, to: '/work-orders?filter=created' },
    { icon: 'kanban', tone: 'blue', t: '待维修工接单', d: '已自动通知默认维修工，久没人接就改派', n: repairStat.accepting, to: '/work-orders?filter=pending_accept' },
    { icon: 'clock', tone: 'amber', t: '已超时工单', d: '超过要求完成时间仍未完工', n: repairStat.overdue, to: '/work-orders?filter=overdue' },
    { icon: 'check', tone: 'blue', t: '待业主验收', d: '可代业主验收或催业主确认', n: repairStat.review, to: '/work-orders?filter=done_pending_review' },
    { icon: 'box', tone: 'amber', t: '等材料的工单', d: '到料后继续维修', n: repairStat.material, to: '/work-orders?filter=waiting_material' },
  ];

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 22 }}>今日工作</h1>
          <p>{dayjs().format('YYYY 年 M 月 D 日 dddd')}{officeName ? ` · ${officeName}` : ''} · 实时数据来自正式库</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => nav('/work-orders?new=1')}><Icon name="plus" size={18} />登记报修</button>
          <button className="btn p" onClick={() => nav('/cashier')}><Icon name="cash" size={18} />收费办理</button>
        </div>
      </div>

      {orderFailure?<div role="alert" className="note">{orderFailure}<button className="btn" onClick={()=>setOrdersRetry(n=>n+1)}>重试工单</button></div>:null}
      {error?<div role="alert" className="note">{error}<button className="btn" onClick={()=>setRetry(n=>n+1)}>重试</button></div>:!data?<div role="status" className="note">正在读取今日流水与全筛选汇总…</div>:null}
      <div className="erp-today-kpis" aria-label="今日工作指标">
        <div className="erp-kpi"><div className="k">今日实收</div><div className="v money" data-testid="today-income">{amount(income)}</div></div>
        <div className="erp-kpi"><div className="k">退款</div><div className="v money">{amount(refund)}</div></div>
        <div className="erp-kpi"><div className="k">收款笔数</div><div className="v">{data ? `${data.summary.paidCount} 笔` : '—'}</div></div>
        <div className="erp-kpi"><div><div className="k">进行中工单</div><div className="v">{orderFailure ? '—' : visibleOrders === null ? '加载中…' : `${repairStat.active} 单`}</div></div></div>
      </div>
      <div className="erp-today-workspace">
        <div>
          <div className="card" style={{ padding: '18px 20px' }}>
            <div className="side-h"><Icon name="wallet" size={19} />主工作区</div>
            <p style={{ color: 'var(--ink2)', margin: '12px 0' }}>{name} · {officeName || '本账号范围'}</p>
            <p>PMS新登记的物业费、泊位费、停车与门禁均计入；源MIS历史另查。</p>
            <button className="btn" onClick={() => nav('/bills')}><Icon name="home" size={18} />账单与待缴</button>
          </div>

          <div className="card" style={{ marginTop: 20, padding: '18px 20px' }}>
            <div className="side-h"><Icon name="chart" size={19} style={{ color: 'var(--acc-t)' }} />今日分项收入</div>
            <div style={{ marginTop: 12 }}>
              {!data ? <p>分项收入未获取</p> : [['停车月租', parkSum, 'var(--acc)'], ['门禁卡', cardSum, 'var(--warn)'], ['物业/泊位', propertySum, 'var(--ok)']].map(([nm, v, col]) => (
                <div key={nm as string} className="erp-income-row">
                  <div style={{ width: 80, fontSize: 16, color: 'var(--ink2)' }}>{nm as string}</div>
                  <div style={{ flex: 1, height: 10, borderRadius: 6, background: 'var(--line2)', overflow: 'hidden' }}><div style={{ height: '100%', borderRadius: 6, width: `${Math.round((v as number) / maxSum * 100)}%`, background: col as string }} /></div>
                  <div style={{ width: 100, textAlign: 'right', fontWeight: 700, fontSize: 16 }}>{money((v as number) / 100)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div>


          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="side-h" style={{ padding: '16px 18px 2px' }}><Icon name="alert" size={19} style={{ color: 'var(--warn)' }} />需要处理</div>
            <div className="rowList">
              {todoRows.map((r) => (
                <button key={r.t} className="lrow click" onClick={() => nav(r.to)}>
                  <div className={`li ic ${r.n ? r.tone : 'blue'}`}><Icon name={r.icon} /></div>
                  <div className="lt"><b>{r.t}</b><small>{r.d}</small></div>
                  <b style={{ fontSize: 20, color: r.n && (r.tone === 'red' || r.tone === 'amber') ? 'var(--dang)' : 'var(--ink)' }}>{orderFailure ? '—' : visibleOrders === null ? '…' : r.n}</b>
                </button>
              ))}
              <button className="lrow click" onClick={() => nav('/pending')}>
                <div className="li ic amber"><Icon name="cpu" /></div>
                <div className="lt"><b>外部任务待处理</b><small>停车/写卡/MIS 的失败与待核验</small></div>
                <Icon name="chev" className="go" />
              </button>
            </div>
          </div>

          <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
            <div className="side-h" style={{ padding: '16px 18px 2px' }}><Icon name="receipt" size={19} style={{ color: 'var(--acc-t)' }} />最近收款</div>
            <div className="rowList">
              {!data?<div className="empty" style={{padding:28}}>流水未获取</div>:paid.length === 0 ? <div className="empty" style={{ padding: 28 }}>最近20笔中无收款项，请查看办理记录</div>
                : paid.slice(0, 5).map((t) => (
                  <div key={t.id} className="lrow">
                    <div className="li ic green"><Icon name={svcIcon(t.serviceType)} /></div>
                    <div className="lt"><b>{SERVICE_LABEL[t.serviceType] || '其他业务'}</b><small>{dayjs(t.createdAt).format('HH:mm')} · {payLabel(t.paymentMethod)} · 单号 {t.txnNo.slice(-6)}</small></div>
                    <b className="money">{money(t.amountCents / 100)}</b>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>

      <div className="note2" style={{ marginTop: 18 }}><Icon name="alert" />按北京时间统计本人范围内全部PMS收款登记，不受最近20条限制；源MIS原有历史缴费另见收费流水。收款事实与外部写入核验分开，结果未知先查原单，不要重复收款。</div>
    </>
  );
}
