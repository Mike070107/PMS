import { useCallback, useEffect, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { AccessCardReadiness } from '@pms/api-client/src/endpoints/access-card-issuance';
import { legacyUrl } from '@/lib/legacy';
import { Loading, ErrorNote, toast } from '@/components/ui';
import { ago } from '@/lib/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import ToneIcon from '@/components/ToneIcon';

const KIND: Record<string, { label: string; icon: IconName }> = {
  issuer: { label: '发卡器助手', icon: 'key' },
  access_gateway: { label: '门禁网关', icon: 'cpu' },
  legacy_sync: { label: '旧库同步', icon: 'refresh' },
  parking_gateway: { label: '停车网关', icon: 'car' },
};
const STATUS: Record<string, { text: string; tone: string; tag: string }> = {
  online: { text: '正常', tone: 'green', tag: 'ok' },
  degraded: { text: '部分可用', tone: 'amber', tag: 'warn' },
  offline: { text: '离线', tone: 'red', tag: 'dang' },
};
const FEATURES: Array<[keyof AccessCardReadiness['features'], string]> = [
  ['cardWrite', '写卡'], ['legacyDbWrite', '旧门禁库写入'], ['accessDbWrite', '新门禁库写入'],
  ['parkingDbRead', '停车库读取'], ['parkingDbWrite', '停车库写入'], ['controllerUpload', '控制器下发'],
];

/**
 * 系统与设备（卡片式，对齐新设计）：现场助手 / 库连接 / 控制器状态集中一页。
 * 数据来自 /access-card-issuance/readiness，和发卡页同一份现场状态；本页只读展示。
 */
export default function Devices() {
  const [data, setData] = useState<AccessCardReadiness | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setData(await accessCardIssuance.readiness()); setErr(''); }
    catch (e) { setErr(e instanceof Error ? e.message : '设备状态读取失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!data && !err) return <Loading />;

  const agents = data?.agents ?? [];
  const online = agents.filter((a) => a.status === 'online').length;
  const offline = agents.filter((a) => a.status !== 'online').length;
  const deliyun = data?.deliyun;

  const stats: Array<{ icon: IconName; tone: string; v: string; k: string }> = data ? [
    { icon: 'cpu', tone: online && !offline ? 'green' : offline ? 'amber' : 'blue', v: `${online}/${agents.length}`, k: '现场助手在线' },
    { icon: 'key', tone: data.features.cardWrite ? 'green' : 'red', v: data.features.cardWrite ? '可用' : '停用', k: `写卡${data.simulationEnabled ? ' · 模拟模式' : ''}` },
    { icon: 'cpu', tone: data.features.controllerUpload ? 'green' : 'red', v: data.features.controllerUpload ? '可用' : '停用', k: '控制器下发' },
    { icon: 'car', tone: deliyun?.connected ? 'green' : deliyun?.configured ? 'red' : 'blue', v: deliyun?.connected ? '已连接' : deliyun?.configured ? '未连接' : '未配置', k: '德立云停车' },
  ] : [];

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="devices" /><h1 style={{ fontSize: 22 }}>系统与设备</h1></div><p>现场助手、库连接、门禁控制器的在线状态集中展示</p></div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); toast('已刷新'); }}><Icon name="refresh" size={18} />刷新</button>
          <button className="btn" onClick={() => { window.location.href = `${import.meta.env.BASE_URL}access-cards`; }}><Icon name="key" size={18} />门禁管理</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      {data ? (
        <>
          <div className="pendGrid" style={{ marginBottom: 4 }}>
            {stats.map((s) => (
              <div key={s.k} className="stat">
                <div className={`ic ${s.tone}`} style={{ width: 44, height: 44 }}><Icon name={s.icon} /></div>
                <div className="v" style={{ fontSize: 22 }}>{s.v}</div>
                <div className="k">{s.k}</div>
              </div>
            ))}
          </div>

          <div className="secTitle"><Icon name="cpu" size={18} />现场助手 / 服务</div>
          <div className="card" style={{ overflow: 'hidden' }}>
            {agents.length ? (
              <div className="rowList">
                {agents.map((a) => {
                  const st = STATUS[a.status] || STATUS.offline;
                  const kind = KIND[a.kind] || { label: a.kind, icon: 'cpu' as IconName };
                  const caps = Object.entries(a.capabilities || {}).filter(([, v]) => v).map(([k]) => k);
                  return (
                    <div key={a.id} className="lrow">
                      <div className={`li ic ${st.tone}`}><Icon name={kind.icon} /></div>
                      <div className="lt">
                        <b>{a.name || a.id} <span className={`tag ${st.tag}`} style={{ marginLeft: 6 }}>{st.text}</span></b>
                        <small>{kind.label} · 版本 {a.version || '—'} · 最近心跳 {a.lastSeenAt ? ago(a.lastSeenAt) : '未知'}{caps.length ? ` · ${caps.slice(0, 4).join('、')}` : ''}</small>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <div className="empty" style={{ padding: 40 }}>还没有注册任何现场助手</div>}
          </div>

          <div className="secTitle"><Icon name="check" size={18} />能力开关 <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 6 }}>由服务端按现场配置下发</span></div>
          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="chips">
              {FEATURES.map(([k, label]) => (
                <span key={k} className={`tag ${data.features[k] ? 'ok' : 'mute'}`}>
                  <Icon name={data.features[k] ? 'check' : 'x'} size={14} />{label}
                </span>
              ))}
            </div>
          </div>

          {deliyun ? (
            <>
              <div className="secTitle"><Icon name="car" size={18} />德立云停车（二期人防）</div>
              <div className="card" style={{ padding: '14px 16px' }}>
                <div className="lrow" style={{ padding: 0 }}>
                  <div className={`li ic ${deliyun.connected ? 'green' : deliyun.configured ? 'red' : 'blue'}`}><Icon name="car" /></div>
                  <div className="lt">
                    <b>{deliyun.connected ? '已连接' : deliyun.configured ? '未连接' : '未配置'}</b>
                    <small>{deliyun.message || '停车续期/暂停任务经此网关下发'}</small>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {data.doorControlBuildings?.length ? (
            <>
              <div className="secTitle"><Icon name="key" size={18} />楼栋门禁下发路由</div>
              <div className="card" style={{ overflow: 'hidden' }}>
                <div className="rowList">
                  {data.doorControlBuildings.map((b) => (
                    <div key={b.id} className="lrow">
                      <div className={`li ic ${b.routeReady ? 'green' : 'red'}`}><Icon name="key" /></div>
                      <div className="lt"><b>{b.buildingNo}</b><small>门禁系统：{b.accessSystem}</small></div>
                      {b.routeReady ? <span className="tag ok"><Icon name="check" />已就绪</span> : <span className="tag dang"><Icon name="alert" />不可达</span>}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />设备注册、远程开门、控制器检测仍在现有「门禁发卡 / 停车管理」页；本页读的是那边的现场状态，集中只读展示。</div>
    </>
  );
}
