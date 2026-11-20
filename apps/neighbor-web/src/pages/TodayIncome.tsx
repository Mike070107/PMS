import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { Sheet } from '@/components/ui';
import Icon from '@/components/Icon';
import { money } from '@/lib/format';

const categories = [
  ['property', '物业费', '#2f9e6e'], ['berth', '泊位费', '#397abc'],
  ['garage', '车辆管理费', '#a5754a'], ['temporary', '临时停车费', '#7964af'],
  ['card', '门禁卡收费', '#458791'], ['repair', '维修费', '#bd624e'],
] as const;
type Category = typeof categories[number][0];
type Row = { paidAt: string; plate: string | null; period: string | null; amountCents: number; remark: string | null };
type Result = { total: number; amountCents: number; rows: Row[] };
type Unavailable = { available: false; reason: string };
type Response = Result | Unavailable;
const fetchIncome = (date: string, category: Category, page?: number) =>
  request<Response>({ url: '/fees/today/income', query: { date, category, page } });

function Details({ date, category, close }: { date: string; category: typeof categories[number]; close: () => void }) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{page: number; data: Response} | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    fetchIncome(date, category[0], page).then(data => { if (active) setResult({page, data}); })
      .catch(() => { if (active) setResult({page, data:{available:false, reason:'明细读取失败'}}); });
    return () => { active = false; };
  }, [category, date, page, retry]);
  const data = result?.page === page ? result.data : null;
  return <Sheet open onClose={close} width={800} title={category[1] + ' · 收费明细'} subtitle={date}>
    {!data ? <p role="status">读取中…</p> : 'reason' in data ? <p>{data.reason} <button className="btn sm" onClick={() => setRetry(n => n+1)}>重试</button></p>
      : !data.total ? <p>当日暂无收费</p> : <>
        <div className="intro-table-wrap"><table className="t usage-table income-details">
          <thead><tr>{['收费时间','车牌','费用时段','收费金额','备注'].map(title => <th key={title}>{title}</th>)}</tr></thead>
          <tbody>{data.rows.map((r,i) => <tr key={i}><td>{r.paidAt}</td><td>{r.plate || '—'}</td><td>{r.period?.replace(/^(\d{4})(\d{2})$/, '$1-$2') || '—'}</td><td className="usage-num">{money(r.amountCents/100)}</td><td>{r.remark || '—'}</td></tr>)}</tbody>
        </table></div>
        <div className="erp-fee-detail-foot"><span>共 {data.total} 条</span>{(page>1 || data.total>20) && <div className="today-recent-pager">
          <button className="btn sm" disabled={page<=1} onClick={() => setPage(n=>n-1)}>上一页</button>
          <span>{page} / {Math.ceil(data.total/20)}</span>
          <button className="btn sm" disabled={page*20>=data.total} onClick={() => setPage(n=>n+1)}>下一页</button>
        </div>}</div></>}
  </Sheet>;
}

export function TodayIncome({ date }: { date: string }) {
  const [values, setValues] = useState<Partial<Record<Category, Response>>>({});
  const [retry, setRetry] = useState(0);
  const [selected, select] = useState<typeof categories[number] | null>(null);
  useEffect(() => {
    let active = true;
    setValues({});
    for (const [id] of categories) {
      const put = (result: Response) => { if (active) setValues(prev => ({ ...prev, [id]:result })); };
      fetchIncome(date, id).then(put).catch(() => put({available:false,reason:'读取失败'}));
    }
    return () => { active = false; };
  }, [date, retry]);
  const total = Object.values(values).reduce((sum,v) => sum+('amountCents' in v ? v.amountCents : 0),0);
  let offset = 0;
  return <><section className="card today-income-card">
    <div className="side-h"><Icon name="chart" size={19}/>今日分项收入</div>
    <div className="erp-fee-breakdown">
      <div className="erp-fee-donut-wrap"><svg viewBox="0 0 100 100" className="erp-fee-donut" aria-hidden="true">
        <circle cx="50" cy="50" r="43" fill="none" stroke="var(--line2)" strokeWidth="9"/>
        {categories.map(cat => {
          const v=values[cat[0]];
          if (!v || !('amountCents' in v) || !v.amountCents || !total) return null;
          const length=v.amountCents/total*100;
          const start=offset;
          offset+=length;
          return <circle key={cat[0]} cx="50" cy="50" r="43" pathLength="100" fill="none" stroke={cat[2]} strokeWidth="9" strokeDasharray={length+' '+(100-length)} strokeDashoffset={-start} transform="rotate(-90 50 50)" className="erp-fee-slice" onClick={()=>select(cat)}/>;
        })}
      </svg><div className="erp-fee-donut-center"><b>{Object.values(values).some(v=>'amountCents' in v) ? money(total/100) : '—'}</b><small>已读取小计</small></div></div>
      <div className="erp-fee-list">{categories.map(cat => {
        const v=values[cat[0]];
        const failed=v && 'reason' in v && v.reason==='读取失败';
        return <button type="button" className="erp-fee-item" key={cat[0]} disabled={!v || ('reason' in v && !failed)}
          onClick={()=>failed ? setRetry(n=>n+1) : select(cat)}>
          <i className="erp-fee-dot" style={{background:cat[2]}}/><span className="erp-fee-name">{cat[1]}</span>
          <span className="erp-fee-value">{!v ? '读取中…' : 'reason' in v ? failed ? '重试' : v.reason : money(v.amountCents/100)}</span>
        </button>;
      })}</div>
    </div>
  </section>
    {selected && <Details category={selected} date={date} close={()=>select(null)}/>}
  </>;
}
