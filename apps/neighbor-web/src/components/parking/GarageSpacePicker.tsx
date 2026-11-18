import { useEffect, useRef, useState } from 'react';
import { Modal } from 'antd';
import { request } from '@pms/api-client';
import { basementLabel, type BasementGarage } from '@/lib/garage-selection';

export interface SpaceChoice { id: number; garage: string; spaceNo: string; unavailableReason?: string }
/** 两个正式入口保留各自权限/API，上层只共享加载状态、竞态保护及选择交互。 */
export function useGarageSpaces(url: string, refreshKey = '') {
  const [rows, setRows] = useState<SpaceChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true; setLoading(true); setError(''); setRows([]);
    void request<{ rows: SpaceChoice[] }>({ url }).then(result => { if (live) setRows(result.rows); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : '读取车位失败'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [url, refreshKey, version]);
  return { rows, loading, error, reload: () => setVersion(x => x + 1) };
}
export default function GarageSpacePicker({ garage, value, source, onCancel, onConfirm }: {
  garage: BasementGarage | null; value: string; source: ReturnType<typeof useGarageSpaces>;
  onCancel: () => void; onConfirm: (space: SpaceChoice) => void;
}) {
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { setSelected(value); setQuery(''); }, [garage, value]);
  const choices = source.rows.filter(s => s.garage === garage);
  const chosen = choices.find(s => s.spaceNo === selected && !s.unavailableReason);
  const visible = choices.filter(s => s.spaceNo.toLowerCase().includes(query.trim().toLowerCase()));
  return <Modal open={!!garage} title={garage ? `选择${basementLabel(garage)}车位号` : ''} width={520}
    onCancel={onCancel} onOk={() => { if (chosen && !source.loading && !source.error) onConfirm(chosen); }}
    afterOpenChange={open => { if (open) search.current?.focus(); }}
    okText="确认车位" cancelText="取消" okButtonProps={{ disabled: !chosen || source.loading || !!source.error }} destroyOnClose>
    <p className="muted">仅显示对应车库档案。必须选定车位后才会勾选授权；取消不会新增授权。</p>
    <label style={{ display: 'block', marginBottom: 12 }}>搜索车位号
      <input ref={search} className="in" aria-label="搜索车位号" value={query} onChange={e => setQuery(e.target.value)} style={{ width: '100%', marginTop: 6 }} />
    </label>
    {source.loading ? <p role="status">正在读取车位…</p> : source.error ? <div role="alert">{source.error}<button type="button" className="btn sm" onClick={source.reload}>重试读取车位</button></div> :
      <div role="radiogroup" aria-label="档案车位" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(100px,1fr))', gap: 8, maxHeight: '40vh', overflowY: 'auto', padding: 2 }}>
        {visible.map(s => <label key={s.id} title={s.unavailableReason || undefined} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 8px', minHeight: 44, border: '1px solid var(--line)', borderRadius: 8, background: selected === s.spaceNo ? 'var(--pri-w)' : 'var(--bg)', cursor: s.unavailableReason ? 'not-allowed' : 'pointer' }}>
          <input type="radio" name="garage-space" value={s.spaceNo} checked={selected === s.spaceNo} disabled={!!s.unavailableReason} onChange={() => setSelected(s.spaceNo)} />
          <span>{s.spaceNo}{s.unavailableReason ? <small style={{ display: 'block' }}>{s.unavailableReason}</small> : null}</span>
        </label>)}
        {!visible.length ? <p>{choices.length ? '没有匹配的车位号' : '该车库暂无可选车位，请先完善对应车库档案。'}</p> : null}
      </div>}
    <p className="muted" style={{ marginBottom: 0 }}>同一车位可关联多个车牌，同时在库限制由停车系统控制。</p>
  </Modal>;
}
