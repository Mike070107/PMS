import { useCallback, useEffect, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { AccessCardReadiness } from '@pms/api-client/src/endpoints/access-card-issuance';
import { Card, ErrorNote, Loading, toast } from '@/components/ui';
import { ago } from '@/lib/format';

const KIND_LABEL: Record<string, string> = {
  issuer: '发卡器助手',
  access_gateway: '门禁网关',
  legacy_sync: '旧库同步',
  parking_gateway: '停车网关',
};

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  online: { text: '正常', cls: 's-done' },
  degraded: { text: '部分可用', cls: 's-pend' },
  offline: { text: '离线', cls: 'urg' },
};

const FEATURE_LABEL: Array<[keyof AccessCardReadiness['features'], string]> = [
  ['cardWrite', '写卡'],
  ['legacyDbWrite', '旧门禁库写入'],
  ['accessDbWrite', '新门禁库写入'],
  ['parkingDbRead', '停车库读取'],
  ['parkingDbWrite', '停车库写入'],
  ['controllerUpload', '控制器下发'],
];

/**
 * 设备中心：把散在各处的本地服务、库连接、控制器状态集中一页。
 * 数据来自 /access-card-issuance/readiness —— 和发卡页用同一份现场状态。
 */
export default function Devices() {
  const [data, setData] = useState<AccessCardReadiness | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await accessCardIssuance.readiness());
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '设备状态读取失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!data && !err) return <Loading text="读取设备状态…" />;

  const agents = data?.agents ?? [];
  const online = agents.filter((a) => a.status === 'online').length;
  const offline = agents.filter((a) => a.status === 'offline').length;

  return (
    <>
      <div className="ph">
        <div>
          <h1>设备中心</h1>
          <p>停车网关、发卡器、门禁控制器的在线状态集中在这里；业务页只显示一条状态带</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); toast('已刷新'); }}>刷新</button>
          <button className="btn" onClick={() => { window.location.href = '/access-cards'; }}>发卡台</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      {data ? (
        <div className="kpis" style={{ marginBottom: 16 }}>
          <div><small>已注册服务</small><b>{agents.length}</b><em>{online} 个正常 · {offline} 个离线</em></div>
          <div><small>写卡</small><b>{data.features.cardWrite ? '可用' : '不可用'}</b><em>{data.simulationEnabled ? '模拟模式已开' : '真实设备'}</em></div>
          <div><small>控制器下发</small><b>{data.features.controllerUpload ? '可用' : '不可用'}</b><em>权限变更能否下发到门禁</em></div>
          <div>
            <small>德立云（二期人防）</small>
            <b>{data.deliyun?.connected ? '已连接' : data.deliyun?.configured ? '未连接' : '未配置'}</b>
            <em>{data.deliyun?.message || '—'}</em>
          </div>
        </div>
      ) : null}

      <Card style={{ overflow: 'hidden' }}>
        <table className="t">
          <thead>
            <tr><th>设备 / 服务</th><th>类型</th><th>状态</th><th>版本</th><th>最近心跳</th><th>能力</th></tr>
          </thead>
          <tbody>
            {agents.length ? agents.map((a) => {
              const st = STATUS_LABEL[a.status] || STATUS_LABEL.offline;
              const caps = Object.entries(a.capabilities || {}).filter(([, v]) => v).map(([k]) => k);
              return (
                <tr key={a.id}>
                  <td><b>{a.name || a.id}</b></td>
                  <td className="sub">{KIND_LABEL[a.kind] || a.kind}</td>
                  <td><span className={`pill ${st.cls}`}>{st.text}</span></td>
                  <td className="muted">{a.version || '—'}</td>
                  <td className="muted">{a.lastSeenAt ? ago(a.lastSeenAt) : '—'}</td>
                  <td className="sub" style={{ fontSize: 12.5 }}>{caps.length ? caps.slice(0, 4).join('、') : '—'}</td>
                </tr>
              );
            }) : <tr><td colSpan={6} className="empty">还没有注册任何本地服务</td></tr>}
          </tbody>
        </table>
      </Card>

      {data ? (
        <>
          <Card style={{ padding: '14px 18px', marginTop: 16 }}>
            <div className="sec-t">能力开关<span className="r muted">由服务端按现场配置下发</span></div>
            <div className="chips">
              {FEATURE_LABEL.map(([k, label]) => (
                <span key={k} className={`pill ${data.features[k] ? 's-done' : 's-off'}`}>
                  {label}{data.features[k] ? ' · 可用' : ' · 不可用'}
                </span>
              ))}
            </div>
          </Card>

          {data.doorControlBuildings?.length ? (
            <Card style={{ padding: '14px 18px', marginTop: 12 }}>
              <div className="sec-t">楼栋门禁下发路由</div>
              <table className="t">
                <thead><tr><th>楼栋</th><th>门禁系统</th><th>路由</th></tr></thead>
                <tbody>
                  {data.doorControlBuildings.map((b) => (
                    <tr key={b.id}>
                      <td><b>{b.buildingNo}</b></td>
                      <td className="sub">{b.accessSystem}</td>
                      <td>{b.routeReady ? <span className="pill s-done">已就绪</span> : <span className="pill urg">不可达</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </>
      ) : null}

      <div className="note" style={{ marginTop: 16 }}>
        设备注册、远程开门、控制器检测仍在现有「门禁发卡 / 停车管理」页；这一页读的就是那边的现场状态，只是把它集中展示。
      </div>
    </>
  );
}
