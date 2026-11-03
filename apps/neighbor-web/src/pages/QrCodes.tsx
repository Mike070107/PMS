import { useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import type { BuildingQrRow } from '@pms/shared-types';
import { legacyUrl } from '@/lib/legacy';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';

interface Community { id: number; name: string }
type Filter = 'all' | 'ready' | 'missing';

const cmpNat = (a: string, b: string) => a.localeCompare(b, 'zh-CN', { numeric: true });

/**
 * 楼栋报修码（beta 新建）：按小区看每栋楼的报修小程序码，缺码/失败一眼可见，可单张或批量重新生成、下载。
 * 走 /qr-codes/buildings、/qr-codes/regenerate。批量补建码与打印排版仍在旧页。
 */
export default function QrCodes() {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [rows, setRows] = useState<BuildingQrRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request<Community[]>({ url: '/communities' })
      .then((l) => { setCommunities(l); if (l.length && communityId === undefined) setCommunityId(l[0].id); })
      .catch(() => setCommunities([]));
  }, []);

  const load = () => {
    if (!communityId) return;
    setRows(null);
    request<BuildingQrRow[]>({ url: '/qr-codes/buildings', query: { communityId } })
      .then((l) => setRows([...l].sort((a, b) => cmpNat(a.lane || '', b.lane || '') || cmpNat(a.buildingNo, b.buildingNo))))
      .catch((e) => { setRows([]); toast(e instanceof Error ? e.message : '加载楼栋码失败'); });
  };
  useEffect(load, [communityId]);

  const stats = useMemo(() => {
    const l = rows ?? [];
    const ready = l.filter((r) => r.qr?.imageUrl).length;
    return { total: l.length, ready, missing: l.length - ready, lastError: l.find((r) => !r.qr?.imageUrl && r.qr?.lastError)?.qr?.lastError };
  }, [rows]);

  const shown = (rows ?? []).filter((r) => filter === 'all' || (filter === 'ready' ? !!r.qr?.imageUrl : !r.qr?.imageUrl));

  const regenerate = async (ids: number[], label: string) => {
    if (!ids.length) return;
    if (!window.confirm(`重新生成${label}？旧码贴出去的仍然有效（同一楼栋 token 不变），只是重新出图。`)) return;
    setBusy(true);
    try {
      const r = await request<{ generated: number; failed: Array<{ reason: string }> }>({ method: 'POST', url: '/qr-codes/regenerate', data: { buildingIds: ids, refreshCaption: true }, timeout: 60000 });
      toast(r.failed.length ? `失败 ${r.failed.length} 张：${r.failed[0].reason}` : `已重新生成 ${r.generated} 张`);
      load();
    } catch (e) { toast(e instanceof Error ? e.message : '生成失败'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><h1 style={{ fontSize: 22 }}>楼栋报修码</h1><p>贴在楼道里，业主扫码直接报修到对应楼栋</p></div>
        <div className="act">
          {stats.missing ? <button className="btn p" disabled={busy} onClick={() => regenerate((rows ?? []).filter((r) => !r.qr?.imageUrl).map((r) => r.buildingId), `缺码的 ${stats.missing} 张`)}><Icon name="refresh" size={18} />补齐缺码 {stats.missing} 张</button> : null}
          <button className="btn" onClick={() => { window.location.href = legacyUrl('/qr'); }}><Icon name="qr" size={18} />批量补建 / 打印排版</button>
        </div>
      </div>

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips">{communities.map((c) => <button key={c.id} className={`chip ${communityId === c.id ? 'on' : ''}`} onClick={() => setCommunityId(c.id)}>{c.name}</button>)}</div>
        <div className="chips" style={{ marginLeft: 'auto' }}>
          {([['all', `全部 ${stats.total}`], ['ready', `已出码 ${stats.ready}`], ['missing', `缺码 ${stats.missing}`]] as Array<[Filter, string]>).map(([k, n]) =>
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{n}</button>)}
        </div>
      </div>

      {stats.lastError ? <div className="note2" style={{ color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />最近一次生成失败：{stats.lastError}</div> : null}

      {rows === null ? <Loading /> : shown.length === 0 ? <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="muted">{rows.length ? '没有符合筛选的楼栋' : '这个小区还没有楼栋'}</span></div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
          {shown.map((r) => {
            const img = r.qr?.imageUrl;
            return (
              <div key={r.buildingId} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 150, height: 150, borderRadius: 10, background: 'var(--bg2, #f4f6f9)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                  {img ? <img src={img} alt={r.buildingText} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span className="muted" style={{ fontSize: 13 }}><Icon name="qr" size={28} /><br />{r.qr?.lastError ? '生成失败' : '未出码'}</span>}
                </div>
                <b style={{ fontSize: 14.5, textAlign: 'center' }}>{r.buildingText}</b>
                <div style={{ display: 'flex', gap: 6 }}>
                  {img ? <a className="btn sm" href={img} download={`${r.communityName}-${r.buildingText}.png`} target="_blank" rel="noreferrer"><Icon name="download" size={15} />下载</a> : null}
                  <button className="btn sm" disabled={busy} onClick={() => regenerate([r.buildingId], `「${r.buildingText}」`)}><Icon name="refresh" size={15} />{img ? '重出' : '生成'}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
