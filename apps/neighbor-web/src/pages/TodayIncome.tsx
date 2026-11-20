import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { Sheet } from '@/components/ui';
import Icon from '@/components/Icon';
import { money } from '@/lib/format';

const categories = [
  ['property', '物业费', '#2f9e6e'], ['berth', '泊位费', '#397abc'],
  ['garage', '车辆管理费', '#a5754a'], ['temporary', '临时停车费（应收）', '#7964af'],
  ['card', '门禁卡收费', '#458791'], ['repair', '维修费', '#bd624e'],
] as const;
type Category = typeof categories[number][0];
const phases = { parking1: '一期', parking2: '二期' } as const;
type Phase = keyof typeof phases;
const phaseKeys: Phase[] = ['parking1', 'parking2'];
type Row = { vehicleClass?: string; paidAt: string; plate: string | null; period: string | null; amountCents: number; remark: string | null };
type Result = { total: number; amountCents: number; rows: Row[] };
type Unavailable = { available: false; reason: string; retryable?: boolean };
type Response = Result | Unavailable;
type PhaseResults = Partial<Record<Phase, Response>>;
type ExitQuery = { id:number; status:string; error?:string; rows:Array<{database:Phase;fields:{
  kind:string; count:number; amountCents:number; occurredAt:string; plate:string; enteredAt?:string; vehicleClass:string; remark?:string;
}}> };
async function fetchIncome(date:string, category:Category, active:()=>boolean, page?:number, phase?:Phase):Promise<Response> {
  if (category !== 'temporary') return request<Response>({url:'/fees/today/income',query:{date,category,page}});
  const url = '/access-card-issuance/parking/fees/details/queries';
  let result = await request<ExitQuery>({url,method:'POST',data:{category:'exit_due',startDate:date,endDate:date,page:page ?? 1,database:phase}});
  for (let attempt=0; attempt<45 && (result.status==='pending' || result.status==='running'); attempt++) {
    await new Promise(resolve=>setTimeout(resolve,2000));
    if (!active()) throw Error('查询已取消');
    result = await request<ExitQuery>({url:url+'/'+result.id});
  }
  if (result.status !== 'completed') throw Error(result.error || '停车助手尚未回传');
  const data:Result = {total:0,amountCents:0,rows:[]};
  if (!phase || result.rows.some(row => row.database !== phase) ||
      result.rows.filter(row => row.fields.kind === 'summary').length !== 1) throw Error('停车库分期回执不完整');
  for (const {fields:f} of result.rows) {
    if (f.kind==='summary') { data.total+=f.count; data.amountCents+=f.amountCents; }
    else data.rows.push({paidAt:f.occurredAt,plate:f.plate,vehicleClass:f.vehicleClass,
      period:f.enteredAt ? f.enteredAt+' 至 '+f.occurredAt : null,amountCents:f.amountCents,remark:f.remark || null});
  }
  return data;
}

function Details({ date, category, firstPage, phase }: { phase?:Phase; firstPage?: Result; date: string; category: typeof categories[number] }) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{page: number; data: Response} | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    if (page === 1 && firstPage) { setResult({page,data:firstPage}); return; }
    fetchIncome(date, category[0], () => active, page, phase).then(data => { if (active) setResult({page, data}); })
      .catch(() => { if (active) setResult({page, data:{available:false, reason:'明细读取失败'}}); });
    return () => { active = false; };
  }, [category, date, page, retry, firstPage, phase]);
  const data = result?.page === page ? result.data : null;
  return <>
    {phase && firstPage && <h3>当期应收 {money(firstPage.amountCents/100)} · {firstPage.total} 笔</h3>}
    {!data ? <p role="status">读取中…</p> : 'reason' in data ? <p>{data.reason} <button className="btn sm" onClick={() => setRetry(n => n+1)}>重试</button></p>
      : !data.total ? <p>当日暂无收费</p> : <>
        <div className="intro-table-wrap"><table className="t usage-table income-details">
          <thead><tr>{(category[0] === 'temporary' ? ['出场时间','车牌','车类','停车时段','应收金额','备注'] : ['收费时间','车牌','费用时段','收费金额','备注']).map(title => <th key={title}>{title}</th>)}</tr></thead>
          <tbody>{data.rows.map((r,i) => <tr key={i}><td>{r.paidAt}</td><td>{r.plate || '—'}</td>{category[0] === 'temporary' && <td>{r.vehicleClass}</td>}<td>{r.period?.replace(/^(\d{4})(\d{2})$/, '$1-$2') || '—'}</td><td className="usage-num">{money(r.amountCents/100)}</td><td>{r.remark || '—'}</td></tr>)}</tbody>
        </table></div>
        <div className="erp-fee-detail-foot"><span>共 {data.total} 条</span>{(page>1 || data.total>20) && <div className="today-recent-pager">
          <button className="btn sm" disabled={page<=1} onClick={() => setPage(n=>n-1)}>上一页</button>
          <span>{page} / {Math.ceil(data.total/20)}</span>
          <button className="btn sm" disabled={page*20>=data.total} onClick={() => setPage(n=>n+1)}>下一页</button>
        </div>}</div></>}
  </>;
}

export function TodayIncome({ date }: { date: string }) {
  const [phaseResults, setPhaseResults] = useState<PhaseResults>({});
  const [phase, setPhase] = useState<Phase | null>(null);
  const [values, setValues] = useState<Partial<Record<Category, Response>>>({});
  const [retry, setRetry] = useState(0);
  const [selected, select] = useState<typeof categories[number] | null>(null);
  useEffect(() => {
    let active = true;
    setValues({}); setPhaseResults({}); setPhase(null);
    for (const [id] of categories) {
      const put = (result: Response) => { if (active) setValues(prev => ({ ...prev, [id]:result })); };
      if (id === 'temporary') {
        for (const key of phaseKeys) {
          const save = (value: Response) => { if (active) setPhaseResults(prev => ({...prev,[key]:value})); };
          fetchIncome(date, id, () => active, 1, key).then(save).catch(error =>
            save({available:false, reason:error instanceof Error ? error.message : '读取失败'}));
        }
        continue;
      }
      fetchIncome(date, id, () => active).then(put).catch(error => put({available:false,reason:error instanceof Error ? error.message : '读取失败',retryable:true}));
    }
    return () => { active = false; };
  }, [date, retry]);
  const visiblePhases = phaseKeys.filter(key => {
    const value = phaseResults[key];
    return !(value && 'reason' in value && value.reason === '当前数据范围不能查看枫桦景苑'+phases[key]+'临时停车费');
  });
  const currentPhase = phase && visiblePhases.includes(phase) ? phase : visiblePhases[0];
  const current = phaseResults[currentPhase];
  const phaseValues = visiblePhases.map(key => phaseResults[key]);
  const phaseLabel = !visiblePhases.length ? '无查看权限' : phaseValues.some(item => !item) ? '读取中…' :
    phaseValues.some(item => item && 'reason' in item) ? '未获取' :
    money(phaseValues.reduce((sum,item) => sum + (item && 'amountCents' in item ? item.amountCents : 0), 0)/100);
  const received = categories.filter(([id]) => id !== 'temporary').map(([id]) => values[id]);
  const total = received.reduce((sum,v) => sum+(v && 'amountCents' in v ? v.amountCents : 0),0);
  let offset = 0;
  return <><section className="card today-income-card">
    <div className="side-h"><Icon name="chart" size={19}/>今日分项收入</div>
    <div className="erp-fee-breakdown">
      <div className="erp-fee-donut-wrap"><svg viewBox="0 0 100 100" className="erp-fee-donut" aria-hidden="true">
        <circle cx="50" cy="50" r="43" fill="none" stroke="var(--line2)" strokeWidth="9"/>
        {categories.map(cat => {
          const v=values[cat[0]];
          if (cat[0] === 'temporary' || !v || !('amountCents' in v) || !v.amountCents || !total) return null;
          const length=v.amountCents/total*100;
          const start=offset;
          offset+=length;
          return <circle key={cat[0]} cx="50" cy="50" r="43" pathLength="100" fill="none" stroke={cat[2]} strokeWidth="9" strokeDasharray={length+' '+(100-length)} strokeDashoffset={-start} transform="rotate(-90 50 50)" className="erp-fee-slice" onClick={()=>select(cat)}/>;
        })}
      </svg><div className="erp-fee-donut-center"><b>{received.some(v=>v && 'amountCents' in v) ? money(total/100) : '—'}</b><small>已读取实收小计</small></div></div>
      <div className="erp-fee-list">{categories.map(cat => {
        const temp = cat[0] === 'temporary';
        const v = values[cat[0]];
        const failed=v && 'reason' in v && v.retryable;
        return <button type="button" className="erp-fee-item" title={v && 'reason' in v ? v.reason : undefined} key={cat[0]} disabled={temp ? !visiblePhases.length : (!v || ('reason' in v && !failed))}
          onClick={()=>failed ? setRetry(n=>n+1) : select(cat)}>
          <i className="erp-fee-dot" style={{background:cat[2]}}/><span className="erp-fee-name">{cat[1]}</span>
          <span className="erp-fee-value">{temp ? phaseLabel : !v ? '读取中…' : 'reason' in v ? failed ? '未获取 · 重试' : v.reason : money(v.amountCents/100)}</span>
        </button>;
      })}</div>
    </div>
  </section>
    {selected && <Sheet open onClose={() => { select(null); setPhase(null); }} width={800} title={selected[1]+'明细'} subtitle={date}>
      {selected[0] !== 'temporary' ? <Details category={selected} date={date}/> : <>
        <div role="tablist" aria-label="小区">{visiblePhases.map(key =>
          <button type="button" role="tab" id={'income-tab-'+key} aria-controls="income-phase-panel" aria-selected={currentPhase===key}
            key={key} className={'btn sm'+(currentPhase===key?' primary':'')} onClick={() => setPhase(key)}>{phases[key]}</button>)}</div>
        <div role="tabpanel" id="income-phase-panel" aria-labelledby={'income-tab-'+currentPhase}>
          {!current ? <p role="status">{visiblePhases.length ? '读取中…' : '无查看权限'}</p> :
            'reason' in current ? <p role="status">{current.reason} <button className="btn sm" onClick={() => setRetry(n=>n+1)}>重试</button></p> :
            <Details key={currentPhase} phase={currentPhase} category={selected} firstPage={current} date={date}/>}
        </div>
      </>}
    </Sheet>}
  </>;
}
