import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { legacyUrl } from '@/lib/legacy';
import Icon from '@/components/Icon';
import { Loading } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';

interface Community { id: number; name: string }
interface Office { id: number; name: string; remark: string | null; enabled: boolean; communities: Community[] }
interface Resp { offices: Office[]; unassigned: Community[] }

/**
 * 管理处（beta 新建）：每个管理处管哪些小区一目了然，未划分的小区单独提醒。
 * 走 /offices。新建/改名/划分小区仍在旧管理处页（影响数据范围，需管理员）。
 */
export default function Offices() {
  const [data, setData] = useState<Resp | null>(null);
  useEffect(() => { request<Resp>({ url: '/offices' }).then(setData).catch(() => setData({ offices: [], unassigned: [] })); }, []);
  if (data === null) return <Loading />;

  const total = data.offices.reduce((s, o) => s + o.communities.length, 0);

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="offices" /><h1 style={{ fontSize: 22 }}>管理处</h1></div><p>{data.offices.length} 个管理处 · 共管 {total} 个小区</p></div>
        <div className="act"><button className="btn" onClick={() => { window.location.href = legacyUrl('/offices'); }}><Icon name="gear" size={18} />新建 / 划分小区</button></div>
      </div>

      {data.unassigned.length ? (
        <div className="note2" style={{ background: 'var(--warn-w, #fbf1dd)', color: 'var(--warn)', borderColor: '#ecd9b0', marginBottom: 14 }}>
          <Icon name="alert" />有 {data.unassigned.length} 个小区还没划入管理处（{data.unassigned.map((c) => c.name).join('、')}），这些小区的工单和收费不会出现在任何管理处视角里。
        </div>
      ) : null}

      {data.offices.length === 0 ? <div className="card" style={{ padding: 48, textAlign: 'center' }}><span className="muted">还没有管理处</span></div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {data.offices.map((o) => (
            <div key={o.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div className={`ic ${o.enabled ? 'blue' : 'red'}`} style={{ width: 40, height: 40 }}><Icon name="building" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 16 }}>{o.name}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>{o.remark || `${o.communities.length} 个小区`}</div>
                </div>
                {o.enabled ? <span className="tag ok">启用</span> : <span className="tag mute">停用</span>}
              </div>
              {o.communities.length ? (
                <div className="chips" style={{ flexWrap: 'wrap' }}>
                  {o.communities.map((c) => <span key={c.id} className="tag acc"><Icon name="home" size={13} />{c.name}</span>)}
                </div>
              ) : <span className="muted" style={{ fontSize: 13 }}>尚未划入小区</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
