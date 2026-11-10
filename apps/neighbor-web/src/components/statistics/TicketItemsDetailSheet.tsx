import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { Loading, Sheet, toast } from '@/components/ui';
import { downloadCsv, fmtCents, ticketItemDetailsCsv, ticketItemsParams,
  type TicketItemsDetailResponse, type TicketItemsQuery } from '@/lib/statistics';

export type TicketItemsTarget = { label: string } & ({ query: TicketItemsQuery; ticketId?: never } | { ticketId: number | string; query?: never });
const LIMIT = 200;

export default function TicketItemsDetailSheet({ target, onClose }: { target: TicketItemsTarget | null; onClose: () => void }) {
  return <Sheet open={!!target} onClose={onClose} width={1120} title="开票逐笔明细" subtitle={target?.label || ''}>
    {target ? <Detail key={JSON.stringify(target)} target={target} /> : null}
  </Sheet>;
}
function Detail({ target }: { target: TicketItemsTarget }) {
  const [report, setReport] = useState<TicketItemsDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'more' | 'export' | ''>('');
  const [retry, setRetry] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [ticketNo, setTicketNo] = useState('');
  const [filters, setFilters] = useState({ keyword: '', ticketNo: '' });
  const generation = useRef(0);
  const operation = useRef(false);
  const fetchPage = (offset = 0) => request<TicketItemsDetailResponse>(target.query ? {
    url: '/statistics/ticket-items/detail', query: { ...ticketItemsParams(target.query), ...filters, offset, limit: LIMIT },
  } : { url: `/statistics/tickets/${encodeURIComponent(String(target.ticketId))}/items` });
  useEffect(() => {
    const token = ++generation.current;
    operation.current = false; setBusy(''); setLoading(true); setError(''); setReport(null);
    fetchPage().then(response => { if (token === generation.current) setReport(response); })
      .catch(e => { if (token === generation.current) setError(e instanceof Error ? e.message : '开票明细读取失败'); })
      .finally(() => { if (token === generation.current) setLoading(false); });
    return () => { generation.current++; };
    // target changes remount this component; each request uses the applied filter snapshot.
  }, [filters, retry]);
  const count = report?.count ?? report?.totals?.itemCount ?? null;
  const scope = target.query ? `管理处 ${target.query.officeCodes.join('、')}；收费项目 ${target.query.feeCodes.join('、')}；开票日期 ${target.query.dateFrom || '不限'} 至 ${target.query.dateTo || '不限'}；票号 ${filters.ticketNo || '不限'}；关键词 ${filters.keyword || '不限'}` : `票据 ${target.label}（ID ${target.ticketId}）`;
  const more = async () => {
    if (!report || operation.current) return;
    const token = generation.current; operation.current = true; setBusy('more');
    try {
      const next = await fetchPage(report.rows.length);
      if (token !== generation.current) return;
      if (!next.available || next.count !== report.count || JSON.stringify(next.totals) !== JSON.stringify(report.totals) || next.dataAsOf !== report.dataAsOf || (!next.rows.length && report.rows.length < (count ?? 0))) throw Error(next.message || '明细发生变化，请重新查询');
      setReport({ ...next, rows: [...report.rows, ...next.rows] });
    } catch (e) { if (token === generation.current) toast(e instanceof Error ? e.message : '加载更多失败'); }
    finally { if (token === generation.current) { operation.current = false; setBusy(''); } }
  };
  const exportAll = async () => {
    if (!report || !report.available || operation.current) return;
    const token = generation.current; operation.current = true; setBusy('export');
    try {
      const rows = [...report.rows];
      while (target.query && rows.length < (count ?? 0)) {
        const next = await fetchPage(rows.length);
        if (token !== generation.current) return;
        if (!next.available || !next.rows.length || next.count !== count || next.dataAsOf !== report.dataAsOf || JSON.stringify(next.totals) !== JSON.stringify(report.totals)) throw Error(next.message || '导出期间数据发生变化，请重新查询后导出');
        rows.push(...next.rows);
      }
      if (token !== generation.current) return;
      if (!downloadCsv('开票逐笔明细.csv', ticketItemDetailsCsv({ ...report, rows }, scope))) throw Error('导出失败，请重试');
      toast(`已导出 ${rows.length} 行开票明细`);
    } catch (e) { if (token === generation.current) toast(e instanceof Error ? e.message : '导出失败'); }
    finally { if (token === generation.current) { operation.current = false; setBusy(''); } }
  };
  return <>
    {target.query ? <form className="stats-ticket-detail-filters" onSubmit={e => { e.preventDefault(); setFilters({ keyword: keyword.trim(), ticketNo: ticketNo.trim() }); }}>
      <label>票据编号（精确）<input className="in" maxLength={60} value={ticketNo} onChange={e => setTicketNo(e.target.value)} /></label>
      <label>关键词<input className="in" maxLength={100} placeholder="票号 / 入库单 / 发票号 / 开票项目 / 费项代码" value={keyword} onChange={e => setKeyword(e.target.value)} /></label>
      <button className="btn sm" type="submit" disabled={!!busy}>查询明细</button>
    </form> : null}
    <p className="muted stats-ticket-note">源全部开票行；非有效净开票或收款。合计覆盖全部匹配明细，不随分页变化。</p>
    {error ? <div className="note2" role="alert">{error}<button type="button" className="btn sm" onClick={() => setRetry(n => n + 1)}>重试</button></div>
      : loading ? <Loading text="读取开票明细…" />
      : report?.available === false ? <div className="note2" role="status">{report.message || '开票明细镜像尚未同步，不能视为 0。'}</div>
      : report ? <>
        {report.ticket ? <p className="stats-ticket-note" data-testid="ticket-header">{report.ticket.officeName || '—'} · {report.ticket.issueDate || '未记录日期'} · {report.ticket.payer || report.ticket.customerName || '未记录付款人'} · {report.ticket.address || '未记录地址'}</p> : null}
        <div className="stats-detail-tools">
          <span data-testid="ticket-item-detail-count">已显示 {report.rows.length} / {count ?? '未知'} 行</span>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => void exportAll()}>{busy === 'export' ? '导出中…' : '导出全部明细 CSV'}</button>
        </div>
        {report.totals ? <div className="stats-summary-chips stats-ticket-totals" data-testid="ticket-item-detail-totals">
          <span className="stats-summary-chip">{report.totals.ticketCount} 张 / {report.totals.itemCount} 行</span>
          <span className="stats-summary-chip">金额 <b>{fmtCents(report.totals.amountCents)}</b></span>
          <span className="stats-summary-chip">税额 <b>{fmtCents(report.totals.taxCents)}</b></span>
          <span className="stats-summary-chip">收入 <b>{fmtCents(report.totals.incomeCents)}</b></span>
        </div> : null}
        {!report.rows.length ? <div className="empty">当前筛选没有开票明细</div> : <div className="t-scroll stats-detail-scroll">
          <table className="t stats-ticket-item-detail-table" data-testid="ticket-item-detail-table">
            <thead><tr><th>票据编号</th><th>管理处</th><th>开票日期</th><th>收费项目</th><th>开票项目</th><th>项目说明</th><th className="num">金额</th><th className="num">税额</th><th className="num">收入</th><th>入库单编号</th><th>发票号</th></tr></thead>
            <tbody>{report.rows.map(r => <tr key={r.itemId}><td>{r.ticketNo || '—'}</td><td>{r.officeName || r.officeCode}</td><td>{r.issueDate || '—'}</td><td>{r.feeName || r.feeCode || '—'}</td><td>{r.itemName || '—'}</td><td>{r.project || '—'}</td><td className="num">{r.amountCents == null ? '—' : fmtCents(r.amountCents)}</td><td className="num">{r.taxCents == null ? '—' : fmtCents(r.taxCents)}</td><td className="num">{fmtCents(r.incomeCents)}</td><td>{r.warehouseNo || '—'}</td><td>{r.invoiceNo || '—'}</td></tr>)}</tbody>
          </table>
        </div>}
        {target.query && count != null && report.rows.length < count ? <div className="stats-load-more"><button type="button" className="btn sm" disabled={!!busy} onClick={() => void more()}>{busy === 'more' ? '加载中…' : '加载更多（每次 200 行）'}</button></div> : null}
      </> : null}
  </>;
}
