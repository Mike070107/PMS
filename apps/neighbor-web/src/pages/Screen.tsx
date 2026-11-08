import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { amountWan, chinaToday, sampleManual, type DecisionSummary, type ScreenSettingsData } from '@/lib/screen-decision';
import '@/styles/screen.css';

function DecisionChart({ data }: { data: DecisionSummary }) {
  const { target, decision, year } = data;
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year, 11, 31);
  const dayX = (key: string) => 64 + (Date.parse(key + 'T00:00:00Z') - start) / (end - start) * 856;
  const max = Math.max(1, target.annualCents, target.yearToDateCents, decision.forecastCents || 0,
    decision.plannedToDateCents || 0, ...decision.planCurve.map(p => p.plannedCents)) * 1.12;
  const y = (v: number) => 278 - v / max * 234;
  let paid = 0;
  const actual = data.trend.map(p => { paid += p.paidCents; return `${dayX(p.key)},${y(paid)}`; });
  const planned = [`64,${y(0)}`, ...decision.planCurve.map(p => `${dayX(p.key)},${y(p.plannedCents)}`)];
  const xNow = Math.max(64, Math.min(920, dayX(data.asOf)));
  return <svg viewBox="0 0 960 330" role="img" aria-label="年度累计实收、计划进度和趋势估算对比">
    <title>年度累计实收、计划进度和趋势估算；金额单位万元</title>
    {[0, 1, 2, 3, 4].map(i => <g key={i}>
      <line x1="64" x2="920" y1={y(max * i / 4)} y2={y(max * i / 4)} className="dec-grid" />
      <text x="52" y={y(max * i / 4) + 4} textAnchor="end">{(max * i / 4 / 1000000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}</text>
    </g>)}
    <text x="24" y="22">万元</text>
    {year === Number(chinaToday().slice(0, 4)) && <rect x={xNow} y="35" width={920 - xNow} height="243" className="dec-future" />}
    {target.annualCents > 0 && <polyline points={planned.join(' ')} className="dec-plan" />}
    {actual.length > 0 && <>
      <polygon points={`64,278 ${actual.join(' ')} ${xNow},278`} className="dec-area" />
      <polyline points={actual.join(' ')} className="dec-actual" />
      <circle cx={xNow} cy={y(target.yearToDateCents)} r="5" className="dec-dot" />
    </>}
    {decision.forecastCents !== null && <line x1={xNow} y1={y(target.yearToDateCents)} x2="920" y2={y(decision.forecastCents)} className="dec-forecast" />}
    {[0, 2, 4, 6, 8, 11].map(m => <text key={m} x={dayX(`${year}-${String(m + 1).padStart(2, '0')}-01`)} y="307" textAnchor="middle">{m + 1}月</text>)}
  </svg>;
}

function ScreenContent() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const initialYear = Number(params.get('year'));
  const [year, setYear] = useState(initialYear >= 2000 && initialYear <= 2100 ? initialYear : Number(chinaToday().slice(0, 4)));
  const [scope, setScope] = useState(params.get('communityIds') || '');
  const [tick, setTick] = useState(0);
  const [rawData, setData] = useState<DecisionSummary | null>(null);
  const [rawSettings, setSettings] = useState<ScreenSettingsData | null>(null);
  const [options, setOptions] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState('');
  const [manualError, setManualError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState('');
  const [fullError, setFullError] = useState('');
  const [loadedKey, setLoadedKey] = useState('');
  const requestKey = `${year}|${scope}|${tick}`;
  const data = loadedKey === requestKey ? rawData : null;
  const settings = loadedKey === requestKey ? rawSettings : null;

  useEffect(() => {
    let active = true;
    setData(null); setSettings(null); setError(''); setManualError(''); setLoading(true);
    void Promise.allSettled([
      request<DecisionSummary>({ url: '/fees/mis/screen-summary', query: { year, communityIds: scope || undefined, granularity: 'day' }, timeout: 30000 }),
      request<ScreenSettingsData>({ url: '/fees/screen-settings', query: { year, communityIds: scope || undefined }, timeout: 15000 }),
      request<{ communities: { id: number; name: string }[] }>({ url: '/fees/mis/options', timeout: 15000 }),
    ]).then(([summary, config, opts]) => {
      if (!active) return;
      if (summary.status === 'fulfilled') {
        setData(summary.value);
        setLoadedAt(new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }));
      } else setError(summary.reason instanceof Error ? summary.reason.message : '经营数据读取失败');
      if (config.status === 'fulfilled') setSettings(config.value);
      else setManualError('人工指标读取失败，请重试');
      if (opts.status === 'fulfilled') setOptions(opts.value.communities || []);
      setLoadedKey(`${year}|${scope}|${tick}`); setLoading(false);
    });
    return () => { active = false; };
  }, [year, scope, tick]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setTick(n => n + 1); };
    const timer = window.setInterval(refresh, 300000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);

  const d = data?.decision, t = data?.target;
  const manual = settings ? settings.manual || sampleManual(year) : null;
  const current = year === Number(chinaToday().slice(0, 4));
  const behind = d?.behindCents;
  const uplift = d?.requiredDailyCents != null && d.recentDailyCents != null && d.recentDailyCents > 0
    ? Math.max(0, Math.round((d.requiredDailyCents / d.recentDailyCents - 1) * 100)) : null;
  const settingsUrl = `/screen-settings?year=${year}${scope ? '&communityIds=' + scope : ''}`;
  const riskCount = d?.projects.filter(p => p.behindCents > 0).length || 0;
  const manualAge = manual ? Math.floor((Date.parse(chinaToday() + 'T00:00:00Z') - Date.parse(manual.asOf.slice(0, 10) + 'T00:00:00Z')) / 86400000) : 0;
  const busy = loading || loadedKey !== requestKey;
  const dataTime = data?.source === 'mirror'
    ? '数据截至 ' + (data.dataAsOf ? new Date(data.dataAsOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未知')
    : '读取于 ' + loadedAt;

  return <main className="decision-screen">
    <header className="dec-head">
      <div className="dec-brand"><Icon name="chart" /><h1>目标达成与经营决策</h1><span>邻修 · 收费经营看板</span></div>
      <div className="dec-controls">
        <details className="dec-picker"><summary>小区 · {scope ? scope.split(',').length + '个' : '全部授权'}</summary>
          <div><button type="button" onClick={() => setScope('')}>选择全部</button>
            {options.map(o => <label key={o.id}><input type="checkbox" checked={!scope || scope.split(',').includes(String(o.id))} onChange={() => {
              const prev = scope ? scope.split(',') : options.map(p => String(p.id));
              const next = prev.includes(String(o.id)) ? prev.filter(id => id !== String(o.id)) : [...prev, String(o.id)];
              if (next.length) setScope(next.join(','));
            }} />{o.name}</label>)}
          </div>
        </details>
        <select aria-label="统计年度" value={year} onChange={e => setYear(Number(e.target.value))}>
          {Array.from({ length: 5 }, (_, i) => Number(chinaToday().slice(0, 4)) + 1 - i).map(y => <option key={y} value={y}>{y}年度</option>)}
        </select>
        <button onClick={() => setTick(n => n + 1)} disabled={busy} aria-label="刷新大屏"><Icon name="refresh" /></button>
        <button onClick={() => { setFullError(''); void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => setFullError('浏览器未允许全屏，可使用 F11')); }}>全屏</button>
        {can('fees', 'edit') && <button onClick={() => nav(settingsUrl)}>大屏设置</button>}
        <button onClick={() => nav('/reports')}>返回后台</button>
      </div>
    </header>
    <div className={`dec-notice ${behind != null && behind > 0 ? 'warning' : ''}`} role="status">
      <Icon name="alert" />
      {busy ? '正在读取经营数据…' : error ? '经营数据读取失败，请点击刷新重试' : !t?.annualCents ? '尚未设置年度目标，请前往大屏设置'
        : !current ? (year < Number(chinaToday().slice(0, 4)) ? `年度已结束，目标缺口 ${amountWan(Math.max(0,t.gapCents))} 万元` : '年度尚未开始，可前往大屏设置维护计划') : behind != null && behind > 0 ? `当前回款落后计划 ${amountWan(behind)} 万元，${riskCount} 个指标组需重点关注`
          : `当前回款领先计划 ${amountWan(Math.abs(behind || 0))} 万元`}
      <span>{loadedAt && !busy ? `${dataTime} · 每5分钟刷新` : ''}</span>
    </div>
    {error && <p className="dec-error" role="alert">{error}</p>}
    {fullError && <p role="alert">{fullError}</p>}
    {data?.partial && <p className="dec-scope-note" title={data.missingTargetCommunities.map(c => c.name).join('、')}>目标仅覆盖已设置指标的小区；未覆盖：{data.missingTargetCommunities.map(c => c.name).join('、')}。</p>}
    <section className="dec-kpis" aria-label="目标概况">
      <div><span>年度目标</span><strong>{t?.annualCents ? amountWan(t.annualCents) : '—'}<small>万元</small></strong><p>{d?.planSource === 'derived' ? '计划含均摊参考' : '按已设月度计划'}</p></div>
      <div><span>目标范围累计实收</span><strong>{t?.annualCents ? amountWan(t.yearToDateCents) : '—'}<small>万元</small></strong><p>年度完成 <b>{t?.rate != null ? t.rate.toFixed(1) + '%' : '—'}</b></p></div>
      <div className={behind != null && behind > 0 ? 'warning' : 'healthy'}><span>{behind != null && behind < 0 ? '领先计划' : '落后计划'}</span><strong>{amountWan(behind == null ? null : Math.abs(behind))}<small>万元</small></strong><p>截至今日应完成 {amountWan(d?.plannedToDateCents)} 万</p></div>
      <div><span>剩余需收</span><strong>{t?.annualCents ? amountWan(Math.max(0, t.gapCents)) : '—'}<small>万元</small></strong><p>{current ? `剩余 ${t?.remainingDays ?? '—'} 天（含今日）` : year < Number(chinaToday().slice(0, 4)) ? '年度已结束' : '年度尚未开始'}</p></div>
      <div><span>每日回款压力</span><strong>{current ? amountWan(d?.requiredDailyCents) : '—'}<small>万元</small></strong><p>近{d?.recentDays || 28}个完整日日均 {amountWan(d?.recentDailyCents)} 万</p><p className="warning">{uplift != null ? uplift > 0 ? `需提升 ${uplift}%` : '当前速度可覆盖日均要求' : current ? '暂无可比速度' : '历史年度不预测'}</p></div>
    </section>
    <div className="dec-middle">
      <section className="dec-panel dec-trend"><header><h2>目标进度与达标趋势</h2><div className="dec-legend"><span>实线 · 实际</span><span>灰虚线 · 计划</span><span>蓝虚线 · 估算</span></div></header>
        {data && t?.annualCents ? <DecisionChart data={data} /> : <div className="dec-empty">{busy ? '正在读取趋势…' : '尚未设置目标，暂无法分析达标趋势'}</div>}
        <div className="dec-forecast-note">{d?.forecastCents != null && t ? <>按近{d.recentDays}日速度估算，年末{d.forecastCents < t.annualCents ? '距目标约' : '超出目标约'} <b>{amountWan(Math.abs(t.annualCents - d.forecastCents))} 万元</b></> : '至少需要14个完整自然日，且已设置目标，才展示趋势估算'}
          <small title="当前累计实收 + 近28个完整日日均 × 今日后剩余自然日；不重复估算今天">趋势参考，不作为回款承诺</small>
        </div>
      </section>
      <section className="dec-panel dec-projects"><header><h2>优先关注项目</h2><span>按落后金额排序</span></header>
        <div className="dec-table-wrap"><table><thead><tr><th>指标组／负责人</th><th>实际 · 计划</th><th>落后金额</th></tr></thead><tbody>
          {d?.projects.slice(0, 6).map(p => <tr key={p.targetId}><td><b>{p.name}</b><small>{p.communityIds.map(id => settings?.owners.find(o => o.communityId === id)?.name).filter(Boolean).join('、') || '负责人未设置'}</small></td>
            <td>{p.rate?.toFixed(1) ?? '—'}% / {p.planRate?.toFixed(1) ?? '—'}%<div className="dec-progress"><i style={{ width: Math.min(100, Math.max(0, p.rate || 0)) + '%' }} /><em style={{ left: Math.min(99, Math.max(0, p.planRate || 0)) + '%' }} /></div></td>
            <td className={p.behindCents > 0 ? 'warning' : 'healthy'}>{p.behindCents > 0 ? amountWan(p.behindCents) + '万' : p.behindCents === 0 ? '持平' : '领先'}</td></tr>)}
        </tbody></table></div>
        {!d?.projects.length && <div className="dec-empty">尚无可考核的指标组</div>}
        <button className="dec-link" onClick={() => nav(settingsUrl)}>查看与维护目标、负责人 <Icon name="chev" /></button>
      </section>
    </div>
    <div className="dec-bottom">
      <section className="dec-panel"><header><h2>优先处理事项</h2><span>{manual?.sample ? '示例数据 · 人工预填' : '人工台账'}</span></header><div className="dec-actions">
        {[{ title: '承诺付款逾期', count: manual?.overdueHouses, cents: manual?.overdueCents, unit: '户' },
          { title: '大额欠费未跟进', count: manual?.untouchedHouses, cents: manual?.untouchedCents, unit: '户' },
          { title: '争议待处理', count: manual?.disputeCount, cents: manual?.disputeCents, unit: '件' }].map(item => <div key={item.title}><h3>{item.title}</h3><strong>{item.count ?? '—'}<small>{item.unit}</small></strong><p>涉及 {amountWan(item.cents)} 万</p></div>)}
      </div></section>
      <section className="dec-panel"><header><h2>催缴行动成效</h2><span>{manual?.sample ? '示例数据' : '人工台账 · 近30日'}</span></header><div className="dec-actions">
        <div><h3>30日跟进后回款</h3><strong>{amountWan(manual?.recoveredCents)}<small>万</small></strong></div>
        <div><h3>承诺兑现率</h3><strong className="healthy">{manual && manual.duePromises > 0 ? (manual.keptPromises / manual.duePromises * 100).toFixed(1) : '—'}<small>%</small></strong><p>{manual ? `${manual.keptPromises} / ${manual.duePromises} 笔到期承诺` : ''}</p></div>
        <div><h3>待跟进</h3><strong>{manual?.pendingHouses ?? '—'}<small>户</small></strong></div>
      </div></section>
    </div>
    <footer className="dec-footer"><span>自动统计：按指标组的费项与收款日期；年度回款目标完成率不等同账单收缴率。</span>
      <span className={manual?.sample || manualAge > 7 ? 'warning' : ''}>{manualError || (!manual ? '人工指标尚未设置' : `${manual.sample ? '示例 · ' : ''}${settings?.manual ? '人工数据截至 ' + manual.asOf.slice(0, 10) : '预填值尚未保存'}${manualAge > 7 ? ' · 已超过7天未更新' : ''}`)}</span>
    </footer>
    {manual?.note && <p className="dec-scope-note" title={manual.note}>人工数据说明：{manual.note}</p>}
  </main>;
}
export default function Screen() {
  const s = useSession();
  return <ScreenContent key={`${s.generation}|${s.actingTenant?.id}|${s.actingOffice?.id}`} />;
}
