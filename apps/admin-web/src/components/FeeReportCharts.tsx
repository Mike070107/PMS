import { Empty, Spin } from 'antd';
import { useId, useState } from 'react';
import { formatFeeMoney } from '@pms/shared-types';

type TrendRow = { bucket: string; amountCents: number; count: number };
type BreakdownRow = { key: string; name: string; amountCents: number; count: number; share: number | null };

/** Both signs share one linear scale; zero is always included. Values remain in cents. */
export function feeScale(values: number[]) {
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  return { min, max: max === min ? min + 1 : max };
}

export function FeeTrendChart({ rows, loading, label }: { rows: TrendRow[]; loading: boolean; label: (bucket: string) => string }) {
  const id = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);
  const { min, max } = feeScale(rows.map(row => row.amountCents));
  const y = (value: number) => 224 - (value - min) / (max - min) * 184;
  const x = (index: number) => rows.length < 2 ? 440 : 88 + index / (rows.length - 1) * 736;
  const points = rows.map((row, index) => `${x(index)},${y(row.amountCents)}`).join(' ');
  const selected = active === null ? null : rows[active];
  const tickIndices = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])].filter(i => i >= 0);
  return <Spin spinning={loading}><div className="fees-trend-chart">
    {!rows.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在读取收费数据' : '所选日期没有收费数据'} /> : <>
      <div className="fees-chart-legend"><span><i />实收金额 · 元</span><span>含红冲冲减</span></div>
      <svg viewBox="0 0 880 272" role="img" aria-label="实收金额趋势，横轴为收费日期，纵轴为元；下方可展开完整明细">
        <defs><linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--ac-brand)" stopOpacity=".28" /><stop offset="100%" stopColor="var(--ac-brand)" stopOpacity=".02" /></linearGradient></defs>
        {[min, (min + max) / 2, max].map((value, index) => <g key={index}><line x1="88" x2="824" y1={y(value)} y2={y(value)} className="fees-chart-grid" /><text x="78" y={y(value) + 4} textAnchor="end">{(value / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</text></g>)}
        <line x1="88" x2="824" y1={y(0)} y2={y(0)} className="fees-chart-zero" />
        {rows.length > 1 && <polygon points={`${x(0)},${y(0)} ${points} ${x(rows.length - 1)},${y(0)}`} fill={`url(#${id}-area)`} />}
        <polyline points={points} fill="none" stroke="var(--ac-brand)" strokeWidth="3" strokeLinejoin="round" />
        {rows.map((row, index) => <circle key={row.bucket} cx={x(index)} cy={y(row.amountCents)} r={active === index ? 6 : 3} tabIndex={0} className="fees-chart-point" aria-label={`${label(row.bucket)}，实收${formatFeeMoney(row.amountCents)}，${row.count}笔`} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}><title>{`${label(row.bucket)} · ${formatFeeMoney(row.amountCents)} · ${row.count}笔`}</title></circle>)}
        {tickIndices.map(index => <text key={index} x={x(index)} y="258" textAnchor="middle">{label(rows[index].bucket)}</text>)}
      </svg>
      <div className="fees-chart-readout" aria-live="polite">{selected ? <><span>{label(selected.bucket)}</span><strong>{formatFeeMoney(selected.amountCents)}</strong><span>{selected.count} 笔</span></> : <span>鼠标指向、点击或键盘选中数据点查看金额</span>}</div>
    </>}
  </div></Spin>;
}

export function FeeBreakdownChart({ rows, loading }: { rows: BreakdownRow[]; loading: boolean }) {
  const { min, max } = feeScale(rows.map(row => row.amountCents));
  const zero = -min / (max - min) * 100;
  return <Spin spinning={loading}><div className="fees-breakdown-chart">
    {!rows.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '正在读取收费数据' : '所选范围无收费记录'} /> : rows.map(row => {
      const end = (row.amountCents - min) / (max - min) * 100;
      return <div className="fees-breakdown-row" key={row.key}>
        <div className="fees-breakdown-label"><span>{row.name}</span><strong className={row.amountCents < 0 ? 'is-negative' : 'is-money'}>{formatFeeMoney(row.amountCents)}</strong></div>
        <div className="fees-breakdown-track" role="img" aria-label={`${row.name}：${formatFeeMoney(row.amountCents)}，${row.count}笔`}>
          <span className="fees-breakdown-zero" style={{ left: `${zero}%` }} />
          <i className={row.amountCents < 0 ? 'is-negative' : ''} style={{ left: `${Math.min(zero, end)}%`, width: `${Math.abs(end - zero)}%` }} />
        </div>
        <small>{row.count} 笔 · 净实收占比 {row.share === null ? '不适用' : `${row.share}%`}</small>
      </div>;
    })}
  </div></Spin>;
}
