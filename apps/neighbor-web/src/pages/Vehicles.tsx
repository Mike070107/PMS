import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingQuery, ParkingQueryRow, DeliyunVehicle } from '@pms/api-client/src/endpoints/access-card-issuance';
import { legacyUrl } from '@/lib/legacy';
import AddressSearch from '@/components/AddressSearch';
import { useAddressTree } from '@/lib/address-tree';
import { Btn, Card, ErrorNote, Loading, Sheet, toast } from '@/components/ui';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import Icon from '@/components/Icon';
import { field, vehicleIdentity, identityTone, GARAGES, garageState, groupByPlate, normPlate } from '@/lib/parking-fields';
import RenewSheet from '@/components/vehicle-ops/RenewSheet';
import { ChangePlateSheet, DownloadSheet, DeleteSheet } from '@/components/vehicle-ops/OtherOpSheets';
import { RebindSheet, GaragesSheet } from '@/components/vehicle-ops/RebindGarageSheets';
import { HistorySheet, OwnerInfoSheet, CreatePmsOwnerSheet } from '@/components/vehicle-ops/HistoryAndOwnerSheets';
import ToneIcon from '@/components/ToneIcon';
import type { Intake } from '@/components/cashier/NewPlateCard';

type IntakeQrResult = Pick<Intake, 'id' | 'qr'>;

type CloudState = 'loading' | DeliyunVehicle | null | undefined;

function go(path: string) { window.location.href = legacyUrl(path); }
function dbLabel(db: string) { return db === 'parking1' ? '一期库' : db === 'parking2' ? '二期库' : db === 'deliyun' ? '德立云' : db; }
function daysLeft(dateStr: string): number | null {
  const d = new Date(dateStr.replace(/[./]/g, '-'));
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/**
 * 住户车辆：一个房号 / 车牌的完整档案。
 *
 * 停车库查询是「提交任务 → 轮询结果」的异步接口（本地网关去读现场库）。
 * 一张车牌可能同时在一期 / 二期库里，这里按车牌并组展示：车辆授权类型、
 * 车库授权清单（P_Effective/P_Download 位解码）、旧库信息 vs PMS 业主信息、
 * 人防（德立云）授权状态。续期 / 改牌 / 调整授权等写操作要走现场网关确认回执，
 * 这一版先把「查得清、看得全」做到位，写操作暂连旧停车管理页。
 */
export default function Vehicles() {
  const [term, setTerm] = useState('');
  const nav = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const [newKind, setNewKind] = useState<'paid' | 'family'>('paid');
  const [newHouse, setNewHouse] = useState<PickedHouse | null>(null);
  const [newQr, setNewQr] = useState<IntakeQrResult | null>(null);
  const [newBusy, setNewBusy] = useState(false);
  const [newErr, setNewErr] = useState('');
  const createIntakeNow = async () => {
    if (!newHouse?.houseId) return;
    setNewBusy(true); setNewErr('');
    try {
      const formBase = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/+$/, '')}/m/plate`;
      const r = await request<IntakeQrResult>({ method: 'POST', url: '/vehicle-intakes', data: { houseId: newHouse.houseId, kind: newKind, formBase } });
      setNewQr(r);
    } catch (e) {
      setNewErr(e instanceof Error ? e.message : '生成二维码失败');
    } finally { setNewBusy(false); }
  };

  const { communities } = useAddressTree();
  const [query, setQuery] = useState<ParkingQuery | null>(null);
  const [polling, setPolling] = useState(false);
  const [err, setErr] = useState('');
  const [cloud, setCloud] = useState<Record<string, CloudState>>({});
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const poll = useCallback(async (id: number, left: number) => {
    if (left <= 0) { setPolling(false); setErr('停车库查询超时，现场网关可能不在线'); return; }
    try {
      const q = await accessCardIssuance.parkingQuery(id);
      setQuery(q);
      if (q.status === 'completed' || q.status === 'failed') {
        setPolling(false);
        if (q.status === 'failed') setErr(q.error || '查询失败');
        return;
      }
      timer.current = window.setTimeout(() => void poll(id, left - 1), 1500);
    } catch (e) {
      setPolling(false);
      setErr(e instanceof Error ? e.message : '查询失败');
    }
  }, []);

  const search = async (kwOverride?: string) => {
    const kw = (kwOverride ?? term).trim();
    if (!kw) return;
    setErr('');
    setQuery(null);
    setCloud({});
    setPolling(true);
    try {
      const created = await accessCardIssuance.createParkingQuery(kw);
      setQuery(created);
      if (created.status === 'completed' || created.status === 'failed') {
        setPolling(false);
        if (created.status === 'failed') setErr(created.error || '查询失败');
        return;
      }
      timer.current = window.setTimeout(() => void poll(created.id, 20), 1200);
    } catch (e) {
      setPolling(false);
      setErr(e instanceof Error ? e.message : '提交查询失败');
    }
  };

  const rows = query?.rows ?? [];
  const groups = useMemo(() => groupByPlate(rows), [rows]);

  // 查询完成后，按车牌拉一次德立云人防授权状态（civil 车库不走旧库位串）
  useEffect(() => {
    if (query?.status !== 'completed') return;
    for (const g of groups) {
      const key = normPlate(g.plate);
      if (!key || cloud[key] !== undefined) continue;
      setCloud((c) => ({ ...c, [key]: 'loading' }));
      accessCardIssuance.deliyunVehiclesByPlate(g.plate)
        .then((r) => {
          const hit = (r.rows || []).find((v) => normPlate(v.plate) === key) || null;
          setCloud((c) => ({ ...c, [key]: hit }));
        })
        .catch(() => setCloud((c) => ({ ...c, [key]: null })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query?.status, groups]);

  return (
    <>
      <div className="ph">
        <div>
          <div className="h1row"><ToneIcon kind="vehicles" /><h1>车辆管理</h1></div>
          <p>按车牌管理车辆：授权车库、有效期、续期收费与车辆档案</p>
        </div>
        <div className="act">
          <button className="btn p" onClick={() => setNewOpen(true)}><Icon name="plus" size={16} />新车登记</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="hsearch" style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <AddressSearch communities={communities} value={term} width={520} live={false}
          placeholder="198/20/601、一期20号601、姓名、电话、车牌，回车查询"
          onTextChange={setTerm}
          onChange={(text) => { setTerm(text); if (text) void search(text); }} />
        <Btn kind="p" size="lg" disabled={polling} onClick={() => void search()}>{polling ? '现场库查询中…' : '查询'}</Btn>
      </div>

          {!query && !polling ? (
            <Card style={{ padding: '52px 20px' }}>
              <div className="empty">输入房号或车牌，从现场停车库读出这个房号的车辆档案</div>
            </Card>
          ) : null}

          {polling && !rows.length ? (
            <Card style={{ padding: 40 }}><Loading text="已提交查询，等待停车网关回读现场库…" /></Card>
          ) : null}

          {groups.length ? (
            <div style={{ marginBottom: 16 }}>
              <div className="muted" style={{ margin: '0 0 10px', fontSize: 14 }}>
                查询「{query?.term}」· {groups.length} 张车牌 · 完成于 {query?.completedAt ? new Date(query.completedAt).toLocaleTimeString('zh-CN') : '—'}
              </div>
              {groups.map((g) => (
                <VehicleCard key={normPlate(g.plate) || g.plate} plate={g.plate} rows={g.rows}
                  cloud={cloud[normPlate(g.plate)]} onChanged={(t) => void search(t || query?.term || term)} />
              ))}
            </div>
          ) : null}

          {query && !polling && !rows.length ? (
            <Card style={{ padding: 36 }}><div className="empty">停车库里没有查到「{query.term}」的记录</div></Card>
          ) : null}
      {newOpen ? (
        <Sheet open onClose={() => { setNewOpen(false); setNewQr(null); }} width={520} title="新车登记" subtitle="业主扫码自己填车牌与资料">
          <div style={{ padding: '4px 2px' }}>
            {!newQr ? (
              <>
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>1. 选这辆车挂在哪一户</div>
                <HousePicker communities={communities} value={newHouse} placeholder="输入 228/5/201 或业主姓名" onPick={setNewHouse} onClear={() => setNewHouse(null)} />
                <div className="muted" style={{ fontSize: 13, margin: '14px 0 6px' }}>2. 类型</div>
                <div className="chips">
                  <button className={`chip ${newKind === 'paid' ? 'on' : ''}`} onClick={() => setNewKind('paid')}>新办车牌（按月收费）</button>
                  <button className={`chip ${newKind === 'family' ? 'on' : ''}`} onClick={() => setNewKind('family')}>亲情车（免费 · 一年）</button>
                </div>
                {newErr ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', margin: '12px 0' }}>{newErr}</div> : null}
                <div style={{ marginTop: 16 }}>
                  <button className="btn p" style={{ width: '100%' }} disabled={newBusy || !newHouse?.houseId} onClick={() => void createIntakeNow()}>
                    <Icon name="qr" size={16} />{newBusy ? '生成中…' : '生成二维码让业主填'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="note" style={{ marginBottom: 12 }}>让业主用微信扫这个码，自己填车牌、手机号并上传资料。填完在「车牌登记审核」里审核。</div>
                {newQr.qr?.dataUrl ? <div style={{ textAlign: 'center' }}><img src={newQr.qr.dataUrl} alt="登记二维码" style={{ width: 240, maxWidth: '100%', height: 'auto' }} /></div> : <ErrorNote>登记单已创建，但未获得二维码图片，请勿重复登记。</ErrorNote>}
                <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                  <button className="btn p" style={{ flex: 1 }} onClick={() => nav('/plates')}><Icon name="check" size={16} />去审核</button>
                  <button className="btn" onClick={() => { setNewQr(null); setNewHouse(null); }}>再登记一台</button>
                </div>
              </>
            )}
          </div>
        </Sheet>
      ) : null}

    </>
  );
}

/** 单张车牌的完整档案卡：车库授权清单 + 旧库 vs PMS 信息 + 写操作入口 */
function VehicleCard({ plate, rows, cloud, onChanged }: { plate: string; rows: ParkingQueryRow[]; cloud: CloudState; onChanged: (requeryTerm?: string) => void }) {
  const [op, setOp] = useState<'renew' | 'changePlate' | 'rebind' | 'garages' | 'download' | 'delete' | 'history' | 'ownerInfo' | 'pmsOwner' | null>(null);  const first = rows[0];
  const identity = vehicleIdentity(field(first?.fields, 'identity'));
  const note = rows.map((r) => field(r.fields, 'note', true)).find(Boolean) || '';
  const expiry = rows.map((r) => field(r.fields, 'expiry')).find(Boolean) || '';
  const pms = rows.find((r) => r.pmsMatch)?.pmsMatch || null;
  const cloudKnown = cloud !== undefined && cloud !== 'loading';
  const civilAuthorized = cloudKnown && cloud ? (cloud as DeliyunVehicle).civilDefenseAuthorized : false;
  const plateQ = encodeURIComponent(plate);
  const expireDays = expiry ? daysLeft(expiry) : null;

  return (
    <Card className="veh-card">
      <div className="veh-head">
        <div className="veh-plate">{plate}</div>
        <span className={`tag ${identityTone(identity)}`}>{identity}</span>
        {rows.map((r) => <span key={r.database} className="veh-db">{dbLabel(r.database)}</span>)}
        {expireDays !== null ? (
          <span className={`pill ${expireDays < 0 ? 's-dang' : expireDays <= 30 ? 's-pend' : 's-done'}`} style={{ marginLeft: 'auto' }}>
            {expireDays < 0 ? `已过期 ${-expireDays} 天` : `剩 ${expireDays} 天到期`}
          </span>
        ) : null}
      </div>

      <div className="veh-section-t">车库授权清单</div>
      <div className="veh-garages">
        {GARAGES.map((gdef) => {
          const st = garageState(rows, gdef);
          const isCivil = gdef.key === 'civil';
          const authed = isCivil ? civilAuthorized : st.authorized;
          let tag: { text: string; cls: string };
          if (isCivil) {
            tag = !cloudKnown ? { text: '人防状态查询中', cls: 's-warn' }
              : civilAuthorized ? { text: '德立云已授权', cls: 's-done' }
                : { text: '德立云未授权', cls: '' };
          } else if (!st.present) {
            tag = { text: '该库无此车牌', cls: '' };
          } else if (st.authorized && st.downloaded) {
            tag = { text: '已授权 · 旧库标记已下载', cls: 's-done' };
          } else if (st.authorized) {
            tag = { text: '已授权 · 设备下发未确认', cls: 's-warn' };
          } else {
            tag = { text: '未授权', cls: '' };
          }
          return (
            <div key={gdef.key} className={`veh-garage ${authed ? 'on' : ''}`}>
              <Icon name={authed ? 'ok-fill' : 'car'} size={16} />
              <b>{gdef.label}</b>
              <span className={`pill ${tag.cls}`}>{tag.text}</span>
            </div>
          );
        })}
      </div>

      <div className="veh-panels">
        <div className="veh-panel">
          <div className="veh-panel-t">旧停车系统信息</div>
          {rows.map((r) => (
            <dl key={r.database} className="veh-dl">
              <dt>{dbLabel(r.database)} 房号</dt><dd>{field(r.fields, 'room', true) || '—'}</dd>
              <dt>电话</dt><dd>{field(r.fields, 'phone', true) || '缺电话'}</dd>
              <dt>车位</dt><dd>{field(r.fields, 'space') || '—'}</dd>
              <dt>有效期</dt><dd>{(field(r.fields, 'begin') || '—')} ~ {(field(r.fields, 'expiry') || '—')}</dd>
            </dl>
          ))}
          {note ? <div className="veh-note">备注：{note}</div> : null}
        </div>
        <div className="veh-panel">
          <div className="veh-panel-t">PMS 系统业主信息</div>
          {pms ? (
            <dl className="veh-dl">
              <dt>业主</dt><dd>{pms.name || '—'}{pms.status === 'disabled' ? <span className="pill s-dang" style={{ marginLeft: 6 }}>已停用</span> : null}</dd>
              <dt>电话</dt><dd>{pms.phone || '—'}</dd>
              <dt>房号</dt><dd>{pms.house ? `${pms.house.communityName || ''} ${pms.house.buildingNo}/${pms.house.roomNo}` : '—'}</dd>
              <dt>匹配方式</dt><dd className="muted">按{pms.matchedBy === 'phone' ? '电话' : '房号'}匹配{pms.contactNote ? ` · ${pms.contactNote}` : ''}</dd>
            </dl>
          ) : (
            <div className="empty" style={{ padding: '14px 0' }}>未匹配到 PMS 房号 / 业主</div>
          )}
        </div>
      </div>

      <div className="veh-ops">
        <button className="btn p sm" onClick={() => setOp('renew')}><Icon name="cash" size={15} />续期收费</button>
        <button className="btn sm" onClick={() => setOp('changePlate')}><Icon name="edit" size={15} />变更车牌</button>
        <button className="btn sm" onClick={() => setOp('rebind')}><Icon name="users" size={15} />变更绑定用户</button>
        <button className="btn sm" onClick={() => setOp('garages')}><Icon name="car" size={15} />调整车库授权</button>
        <button className="btn sm" onClick={() => setOp('history')}><Icon name="clock" size={15} />变更历史</button>
        <button className="btn sm" onClick={() => setOp('ownerInfo')}><Icon name="users" size={15} />更新住户资料</button>
        <button className="btn sm" onClick={() => setOp('pmsOwner')}><Icon name="plus" size={15} />补建PMS业主</button>
        <button className="btn sm" onClick={() => setOp('download')}><Icon name="download" size={15} />下发设备</button>
        <button className="btn g sm" onClick={() => setOp('delete')}><Icon name="trash" size={15} />注销车辆</button>
      </div>
      <div className="veh-hint">六项写操作 + 变更历史 / 更新住户资料 / 补建 PMS 业主都在本页直接办，走现场网关并等回执。</div>

      {op === 'renew' ? (
        <RenewSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'changePlate' ? (
        <ChangePlateSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={(t) => { setOp(null); onChanged(t); }} />
      ) : null}
      {op === 'rebind' ? (
        <RebindSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'garages' ? (
        <GaragesSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'history' ? (
        <HistorySheet plate={plate} rows={rows} onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'ownerInfo' ? (
        <OwnerInfoSheet plate={plate} rows={rows} onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'pmsOwner' ? (
        <CreatePmsOwnerSheet plate={plate} rows={rows} onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'download' ? (
        <DownloadSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'delete' ? (
        <DeleteSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
    </Card>
  );
}
