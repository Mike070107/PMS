import { useCallback, useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { toast } from '@/components/ui';
import { Section, Row, Stat, errMsg } from './parts';

type Status = {
  mode: 'mis' | 'mirror';
  dataAsOf: string | null;
  bills?: number;
  owners?: number;
  fee_items?: number;
  state: Array<{ source_table: string; last_success_at: string | null; last_error: string | null; lag_rows: number; synced_rows: number }>;
};

const fmt = (value: string | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';

/** MIS 镜像：数据源切换、手工全量重灌、对账入口。 */
export default function MisMirrorSection({ canEdit }: { canEdit: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { setStatus(await request<Status>({ url: '/fees/mis/mirror/status' })); setErr(''); }
    catch (e) { setErr(errMsg(e, '镜像状态读取失败')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const setMode = async (mode: 'mis' | 'mirror') => {
    setBusy('mode');
    try { await request({ method: 'PATCH', url: '/fees/mis/mirror/mode', data: { mode } }); toast(mode === 'mirror' ? '已切换为本地镜像' : '已切换为 MIS 直连'); await load(); }
    catch (e) { toast(errMsg(e, '切换失败')); } finally { setBusy(''); }
  };
  const reload = async () => {
    if (!window.confirm('全量重灌会从 MIS 分批读取全部账单，耗时较长，确认现在执行？')) return;
    setBusy('reload');
    try { const r = await request<{ rows: number }>({ method: 'POST', url: '/fees/mis/mirror/reload', timeout: 1_800_000 }); toast(`重灌完成：${r.rows} 行`); await load(); }
    catch (e) { toast(errMsg(e, '重灌失败')); } finally { setBusy(''); }
  };
  const reconcile = async () => {
    setBusy('reconcile');
    try { const r = await request<any>({ method: 'GET', url: '/fees/mis/mirror/reconcile', timeout: 60_000 }); toast(r.ok ? '对账一致' : `不一致：记录差 ${r.totalDiff}、金额差 ${r.amountDiff} 分`); await load(); }
    catch (e) { toast(errMsg(e, '对账失败')); } finally { setBusy(''); }
  };
  const source = status?.state?.find((item) => item.source_table === 'bill');

  return (
    <Section title="MIS 数据源" desc="大屏、今日页和住户列表可读 PMS 本地镜像，避免频繁直连 MIS；默认仍为 MIS 直连。">
      {err ? <div className="note2">{err}</div> : null}
      <Row label="当前数据源" hint={status?.mode === 'mirror' ? '报表/大屏不再查询 MIS；数据有最多 5 分钟同步延迟。' : '保持原有 MIS 直连口径。'}>
        <div className="chips">
          <button className={'chip ' + (status?.mode === 'mis' ? 'on' : '')} disabled={!canEdit || !!busy} onClick={() => void setMode('mis')}>MIS 直连</button>
          <button className={'chip ' + (status?.mode === 'mirror' ? 'on' : '')} disabled={!canEdit || !!busy} onClick={() => void setMode('mirror')}>本地镜像</button>
        </div>
      </Row>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '12px 0' }}>
        <Stat label="镜像账单" value={status?.bills ?? '—'} />
        <Stat label="镜像业主" value={status?.owners ?? '—'} />
        <Stat label="收费项目" value={status?.fee_items ?? '—'} />
        <Stat label="数据截至" value={fmt(status?.dataAsOf)} warn={!status?.dataAsOf} />
        <Stat label="滞后行数" value={source?.lag_rows ?? 0} />
      </div>
      <Row label="最近同步" hint={source?.last_error || '无错误'}>
        <span className={source?.last_error ? 'set-bad' : 'muted'}>{fmt(source?.last_success_at)}</span>
      </Row>
      <div className="chips" style={{ marginTop: 12 }}>
        <button className="btn" disabled={!canEdit || !!busy} onClick={() => void reload()}>{busy === 'reload' ? '重灌中…' : '手工全量重灌'}</button>
        <button className="btn" disabled={!canEdit || !!busy} onClick={() => void reconcile()}>{busy === 'reconcile' ? '对账中…' : '立即对账'}</button>
        <button className="btn" disabled={!!busy} onClick={() => void load()}>刷新状态</button>
      </div>
    </Section>
  );
}
