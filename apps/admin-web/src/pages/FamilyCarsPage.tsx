import {
  App as AntdApp,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Image,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, QrcodeOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { accessCardIssuance, address as addressApi, familyCars, isApiEnvelope } from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth, pagePerm, auth } from '../lib/auth';
import { buildParkingRoomOptions, type ParkingRoomOption } from '../lib/parkingVehicleMerge';
import { exportXlsx } from '../lib/exportXlsx';
import './FamilyCarsPage.css';

const { Text } = Typography;
type Row = familyCars.FamilyCarRow;
type Detail = familyCars.FamilyCarDetail;
type Qr = familyCars.FamilyCarQr;
type LegacyRow = accessCardIssuance.ParkingQueryRow;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
const RELATIONS = ['父母', '子女', '配偶', '兄弟姐妹', '祖父母/外祖父母', '孙子女/外孙子女', '其他亲属'];
const GARAGES: Array<{ key: string; label: string }> = [
  { key: 'phase1', label: '一期停车库' },
  { key: 'phase2', label: '二期地面车库' },
  { key: 'main', label: '二期大车库' },
  { key: 'civil', label: '二期人防车库' },
];
const GARAGE_LABEL = Object.fromEntries(GARAGES.map((g) => [g.key, g.label]));
const STATUS_COLOR: Record<string, string> = {
  upload: 'orange', office: 'blue', manager: 'purple', returned: 'red', opening: 'processing',
  active: 'green', expired: 'default', void: 'default',
};
const LIVE = ['upload', 'office', 'manager', 'returned', 'opening', 'active'];

const normalizePlate = (value: string) => value.replace(/[\s·.．・]/g, '').toUpperCase().slice(0, 8);
const plateValid = (plate: string) => /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}$/.test(plate);

function Plate({ value }: { value: string }) {
  return <span className={`family-plate ${value.length === 8 ? 'is-green' : ''}`}>{normalizePlate(value)}</span>;
}

function StatusTag({ row }: { row: Row }) {
  if (row.status === 'active' && row.expiringSoon) return <Tag color="warning">{row.daysLeft} 天后到期</Tag>;
  if (row.status === 'opening' && row.lastError) return <Tag color="error">开通失败</Tag>;
  return <Tag color={STATUS_COLOR[row.status]}>{row.statusLabel}</Tag>;
}

async function executeParkingQuery(term: string) {
  let query = await accessCardIssuance.createParkingQuery(term);
  for (let attempt = 0; attempt < 90 && (query.status === 'pending' || query.status === 'running'); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    query = await accessCardIssuance.parkingQuery(query.id);
  }
  if (query.status === 'completed') return query;
  if (query.status === 'failed') throw new Error(query.error || '停车数据库查询失败');
  throw new Error('停车网关响应超时，请确认现场电脑仍在线后重试');
}

function legacyField(row: LegacyRow, aliases: string[]) {
  const entries = Object.entries(row.fields || {}).filter(([, value]) => value !== null && String(value).trim() !== '');
  for (const alias of aliases) {
    const hit = entries.find(([key]) => key.toLowerCase().replace(/[\s_\-./]/g, '') === alias);
    if (hit) return String(hit[1]).trim();
  }
  return '';
}
const legacyPlate = (row: LegacyRow) => normalizePlate(legacyField(row, ['pplate', 'plate', 'carno', 'plateno']));
const legacyIdentity = (row: LegacyRow) => legacyField(row, ['carbrand', 'carbeand']);
const legacyRoom = (row: LegacyRow) => {
  const parts = legacyField(row, ['ownername', 'owneradd', 'owneraddress']).match(/\d+/g);
  return parts && parts.length >= 3 ? parts.slice(-3).map((part) => String(Number(part))).join('/') : '';
};
const legacyEnd = (row: LegacyRow) => legacyField(row, ['endtime', 'enddate']).slice(0, 10);

async function uploadFiles(id: number, files: File[]): Promise<Detail> {
  const form = new FormData();
  files.forEach((file) => form.append('file', file, file.name || `截图-${Date.now()}.png`));
  const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const acting = auth.getActingTenant();
  if (acting) headers['x-acting-tenant-id'] = String(acting.id);
  const office = auth.getActingOffice();
  if (office) headers['x-acting-office-id'] = String(office.id);
  const res = await fetch(`${API_BASE_URL}/family-cars/${id}/files`, { method: 'POST', headers, body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || `上传失败（HTTP ${res.status}）`);
  return (isApiEnvelope(body) ? body.data : body) as Detail;
}

const qrKey = (id: number) => `family-car-qr-${id}`;
function rememberQr(carId: number, qr: Qr) { try { sessionStorage.setItem(qrKey(carId), JSON.stringify(qr)); } catch { /* 存不下就只在本次显示 */ } }
function recallQr(carId: number): Qr | null {
  try {
    const qr = JSON.parse(sessionStorage.getItem(qrKey(carId)) || 'null') as Qr | null;
    return qr && new Date(qr.expiresAt).getTime() > Date.now() ? qr : null;
  } catch { return null; }
}
function countdown(expiresAt: string, now: number) {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'todo', label: '我的待办' },
  { key: 'opening', label: '开通中' },
  { key: 'active', label: '已生效' },
  { key: 'soon', label: '30 天内到期' },
  { key: 'expired', label: '已过期' },
  { key: 'all', label: '全部' },
];

export default function FamilyCarsPage() {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const canEdit = pagePerm(access, 'family-cars').canEdit;
  const canApprove = pagePerm(access, 'family-cars-approve').canEdit || !!access?.isTenantAdmin;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('todo');
  const [lane, setLane] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [register, setRegister] = useState<{ open: boolean; source?: Row }>({ open: false });
  const [importOpen, setImportOpen] = useState(false);
  const [popupQr, setPopupQr] = useState<{ id: number; qr: Qr } | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await familyCars.list({ status: 'all' });
      setRows(data.rows); setError('');
    } catch (e) { if (!quiet) setError(e instanceof Error ? e.message : '读取亲情车清册失败'); }
    finally { if (!quiet) setLoading(false); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(true), 15_000); return () => window.clearInterval(timer); }, [load]);

  const isTodo = useCallback((row: Row) => (canEdit && ['upload', 'office', 'returned'].includes(row.status))
    || (canApprove && row.status === 'manager') || (canEdit && row.status === 'opening' && !!row.lastError), [canApprove, canEdit]);
  const match: Record<string, (row: Row) => boolean> = useMemo(() => ({
    todo: isTodo,
    opening: (row) => row.status === 'opening',
    active: (row) => row.status === 'active',
    soon: (row) => row.status === 'active' && row.expiringSoon,
    expired: (row) => row.status === 'expired',
    all: () => true,
  }), [isTodo]);
  const visible = useMemo(() => {
    const term = q.trim();
    const plateTerm = normalizePlate(term);
    return rows.filter((row) => match[filter](row) && (filter === 'all' || row.status !== 'void')
      && (!lane || row.lane === lane)
      && (!term || [row.roomKey, row.ownerName, row.carOwnerName, row.carOwnerPhone, row.ownerPhone, row.remark].some((v) => v.includes(term)) || (!!plateTerm && row.plate.includes(plateTerm))));
  }, [filter, lane, match, q, rows]);

  const exportList = async () => {
    await exportXlsx(`亲情车清册_${dayjs().format('YYYY-MM-DD')}`, [{
      name: '亲情车清册',
      columns: [
        { title: '弄', key: 'lane' }, { title: '号', key: 'buildingNo' }, { title: '室', key: 'roomNo' },
        { title: '业主姓名', key: 'ownerName' }, { title: '车主姓名', key: 'carOwnerName' }, { title: '车主联系电话', key: 'carOwnerPhone' },
        { title: '与业主关系', key: 'relation' }, { title: '车牌号', key: 'plate' }, { title: '状态', key: 'statusLabel' },
        { title: '生效日', key: 'startDate' }, { title: '有效期至', key: 'endDate' }, { title: '备注', key: 'remark' },
      ],
      rows: visible,
    }]);
    message.success(`已导出 ${visible.length} 条`);
  };

  const action = (row: Row) => {
    if (canEdit && row.status === 'upload') return <Button size="small" onClick={() => setOpenId(row.id)}>上传资料</Button>;
    if (canEdit && (row.status === 'office' || row.status === 'returned')) return <Button size="small" type="primary" onClick={() => setOpenId(row.id)}>{row.status === 'returned' ? '处理退回' : '审核'}</Button>;
    if (canApprove && row.status === 'manager') return <Button size="small" type="primary" onClick={() => setOpenId(row.id)}>经理审核</Button>;
    if (canEdit && (row.status === 'expired' || (row.status === 'active' && row.expiringSoon))) {
      const renewing = rows.some((other) => other.id !== row.id && other.plate === row.plate && LIVE.includes(other.status) && other.status !== 'active');
      if (!renewing) return <Button size="small" onClick={(event) => { event.stopPropagation(); setRegister({ open: true, source: row }); }}>续登</Button>;
    }
    return <Button size="small" type="link" onClick={() => setOpenId(row.id)}>详情</Button>;
  };

  return <div className="family-page">
    <div className="family-stats">
      {FILTERS.map((item) => {
        const count = rows.filter((row) => match[item.key](row) && (item.key === 'all' || row.status !== 'void')).length;
        return <button key={item.key} type="button" className={`family-stat ${filter === item.key ? 'is-on' : ''}`} onClick={() => setFilter(item.key)}>
          <small>{item.label}</small><b className={count && (item.key === 'todo' || item.key === 'soon') ? 'is-hot' : ''}>{count}</b>
        </button>;
      })}
    </div>
    <div className="family-card">
      <div className="family-bar">
        <Select style={{ width: 120 }} value={lane} onChange={setLane} options={[{ value: '', label: '全部弄' }, { value: '198', label: '198 弄' }, { value: '228', label: '228 弄' }]} />
        <Input allowClear style={{ width: 300 }} placeholder="搜房号、业主、车主、电话、车牌" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        <div className="family-bar-right">
          <Button onClick={() => void exportList()} disabled={!visible.length}>导出 Excel</Button>
          {canEdit && <Button onClick={() => setImportOpen(true)}>从停车库导入</Button>}
          {canEdit && <Button type="primary" onClick={() => setRegister({ open: true })}>＋ 登记亲情车</Button>}
        </div>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ margin: 16 }} />}
      <Table<Row>
        rowKey="id" size="middle" loading={loading} dataSource={visible} pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        onRow={(row) => ({ onClick: () => setOpenId(row.id), className: 'family-row' })}
        locale={{ emptyText: <Empty description={filter === 'todo' ? '没有需要你处理的亲情车' : '没有符合条件的记录'} /> }}
        scroll={{ x: 1180 }}
        columns={[
          { title: '弄', dataIndex: 'lane', width: 60 },
          { title: '号', dataIndex: 'buildingNo', width: 56 },
          { title: '室', dataIndex: 'roomNo', width: 70 },
          { title: '业主姓名', dataIndex: 'ownerName', width: 96 },
          { title: '车主姓名', dataIndex: 'carOwnerName', width: 96, render: (v: string) => v || <Text type="secondary">待填写</Text> },
          { title: '车主联系电话', dataIndex: 'carOwnerPhone', width: 130, render: (v: string) => v || <Text type="secondary">—</Text> },
          { title: '与业主关系', dataIndex: 'relation', width: 100, render: (v: string) => v || <Text type="secondary">—</Text> },
          { title: '车牌号', dataIndex: 'plate', width: 116, render: (v: string) => <Plate value={v} /> },
          { title: '状态', key: 'status', width: 120, render: (_: unknown, row) => <StatusTag row={row} /> },
          { title: '有效期至', dataIndex: 'endDate', width: 110, render: (v: string | null, row) => v ? <span className={row.status === 'expired' ? 'family-muted' : ''}>{v}</span> : <Text type="secondary">开通后起算</Text> },
          { title: '备注', dataIndex: 'remark', ellipsis: true },
          { title: '', key: 'op', width: 110, fixed: 'right', render: (_: unknown, row) => <span onClick={(e) => e.stopPropagation()}>{action(row)}</span> },
        ]}
      />
    </div>
    {register.open && <RegisterDrawer source={register.source} onClose={() => setRegister({ open: false })} onCreated={(detail, qr, ownerFill) => {
      setRegister({ open: false });
      rememberQr(detail.id, qr);
      setOpenId(detail.id);
      if (ownerFill) setPopupQr({ id: detail.id, qr });
      void load(true);
    }} />}
    {openId && <DetailDrawer id={openId} canEdit={canEdit} canApprove={canApprove} onClose={() => { setOpenId(null); void load(true); }}
      onShowQr={(qr) => setPopupQr({ id: openId, qr })} onChanged={() => void load(true)}
      onRenew={(row) => { setOpenId(null); setRegister({ open: true, source: row }); }} />}
    {popupQr && <QrModal carId={popupQr.id} qr={popupQr.qr} onClose={() => setPopupQr(null)} />}
    {importOpen && <ImportFamilyCarsModal onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void load(true); }} />}
  </div>;
}

/* ---------------- 二维码弹窗 ---------------- */
function QrModal({ carId, qr, onClose }: { carId: number; qr: Qr; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const now = useNow(true);
  const [status, setStatus] = useState<string>('waiting');
  const [car, setCar] = useState<Detail | null>(null);
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try { const d = await familyCars.detail(carId); if (!active) return; setCar(d); setStatus(d.upload?.id === qr.id ? d.upload.status : 'expired'); } catch { /* 下次再试 */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [carId, qr.id]);
  const expired = new Date(qr.expiresAt).getTime() <= now || status === 'expired';
  return <Modal open onCancel={onClose} footer={null} width={460} centered className="family-qr-modal">
    <div className="family-qr-pop">
      <h3>请业主用微信扫码</h3>
      <div className="family-muted">{car ? `${car.lane} 弄 ${car.buildingNo} 号 ${car.roomNo} 室` : ''} · <Plate value={qr.plate} /></div>
      <div className={`family-qr-img ${expired || status === 'submitted' ? 'is-off' : ''}`}>
        <img src={qr.qrDataUrl} alt="亲情车资料上传二维码" />
        {(expired || status === 'submitted') && <span>{status === 'submitted' ? '业主已提交' : '已失效'}</span>}
      </div>
      <div className="family-qr-state">
        {status === 'submitted' ? <Tag color="success">业主已提交资料，已进入办公室审核</Tag>
          : status === 'opened' ? <Tag color="processing">业主已打开页面，正在填写…</Tag>
            : expired ? <Tag>已失效，请重新生成</Tag> : <Tag color="warning">等待业主扫码</Tag>}
        {!expired && status !== 'submitted' && <>剩余 <b>{countdown(qr.expiresAt, now)}</b></>}
      </div>
      <Text type="secondary">业主填写车主信息、上传资料并提交后，办公室这里自动收到（约 3 秒内）</Text>
      <Space style={{ marginTop: 14 }}>
        <Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard?.writeText(qr.url); message.success('链接已复制，可粘贴到微信发给业主'); }}>复制链接发微信</Button>
        <Button type="primary" onClick={onClose}>{status === 'submitted' ? '去审核' : '关闭'}</Button>
      </Space>
    </div>
  </Modal>;
}

/* ---------------- 登记 ---------------- */
type PlateCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'error'; message: string }
  | { state: 'ok'; queryId: number; mode: 'new' | 'existing'; at: number; message: string }
  | { state: 'conflict'; message: string };

function RegisterDrawer({ source, onClose, onCreated }: { source?: Row; onClose: () => void; onCreated: (detail: Detail, qr: Qr, ownerFill: boolean) => void }) {
  const { message } = AntdApp.useApp();
  const [communities, setCommunities] = useState<AddressCommunity[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [roomKeySel, setRoomKeySel] = useState('');
  const [context, setContext] = useState<familyCars.FamilyCarHouseContext | null>(null);
  const [legacy, setLegacy] = useState<{ loading: boolean; rows: LegacyRow[]; error: string }>({ loading: false, rows: [], error: '' });
  const [plate, setPlate] = useState(source ? normalizePlate(source.plate) : '');
  const [check, setCheck] = useState<PlateCheck>({ state: 'idle' });
  const [who, setWho] = useState<'office' | 'owner'>('office');
  const [carOwnerName, setCarOwnerName] = useState(source?.carOwnerName || '');
  const [carOwnerPhone, setCarOwnerPhone] = useState(source?.carOwnerPhone || '');
  const [relation, setRelation] = useState(source?.relation || '');
  const [remark, setRemark] = useState(source ? (source.status === 'expired' || source.status === 'active' ? '续登' : '') : '');
  const [garages, setGarages] = useState<string[]>(source?.garages || []);
  const [garageNumbers, setGarageNumbers] = useState<Record<string, string>>(source?.garageNumbers || {});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    addressApi.tree().then(setCommunities).catch((e) => setFormError(e instanceof Error ? e.message : 'PMS 房号读取失败')).finally(() => setRoomsLoading(false));
  }, []);
  const rooms = useMemo(() => buildParkingRoomOptions(communities), [communities]);
  const selected: ParkingRoomOption | null = rooms.find((room) => room.key === roomKeySel) || null;
  useEffect(() => {
    if (source?.houseId && rooms.length && !roomKeySel) {
      const hit = rooms.find((room) => room.key.startsWith(`${source.houseId}:`));
      if (hit) setRoomKeySel(hit.key);
    }
  }, [roomKeySel, rooms, source?.houseId]);

  const houseId = selected ? Number(selected.key.split(':')[0]) : null;
  useEffect(() => {
    if (!houseId || !selected) { setContext(null); setLegacy({ loading: false, rows: [], error: '' }); return undefined; }
    let active = true;
    familyCars.houseContext(houseId).then((data) => {
      if (!active) return;
      setContext(data);
      if (!source) setGarages(data.house.garages);
    }).catch((e) => active && setFormError(e instanceof Error ? e.message : '读取房号失败'));
    setLegacy({ loading: true, rows: [], error: '' });
    executeParkingQuery(selected.roomKey)
      .then((query) => active && setLegacy({ loading: false, rows: query.rows.filter((row) => legacyIdentity(row).includes('亲情')), error: '' }))
      .catch((e) => active && setLegacy({ loading: false, rows: [], error: e instanceof Error ? e.message : '旧库查询失败' }));
    return () => { active = false; };
  }, [houseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCheck = useCallback(async (value: string, room: string): Promise<PlateCheck> => {
    const [query, cloud] = await Promise.all([executeParkingQuery(value), accessCardIssuance.deliyunVehiclesByPlate(value).catch(() => ({ rows: [] as accessCardIssuance.DeliyunVehicle[] }))]);
    const matches = query.rows.filter((row) => legacyPlate(row) === value);
    if (!matches.length) {
      if (cloud.rows.length) return { state: 'conflict', message: `该车牌已在德立云二期人防车库登记，不能作为新车登记；请先在停车管理核对` };
      return { state: 'ok', queryId: query.id, mode: 'new', at: Date.now(), message: '一期、二期、人防三库均未登记，审核通过后新开通' };
    }
    for (const row of matches) {
      const where = row.database === 'parking1' ? '一期停车库' : '二期停车库';
      if (!legacyIdentity(row).includes('亲情')) return { state: 'conflict', message: `该车牌已在${where}登记为「${legacyIdentity(row) || '未知身份'}」，不能登记为亲情车` };
      if (room && legacyRoom(row) && legacyRoom(row) !== room) return { state: 'conflict', message: `该车牌已在${where}登记为 ${legacyRoom(row)} 的亲情车` };
    }
    return { state: 'ok', queryId: query.id, mode: 'existing', at: Date.now(), message: '旧库已是本户亲情车：审核通过后重新授权并续期一年' };
  }, []);

  useEffect(() => {
    if (!plateValid(plate) || !selected) { setCheck({ state: 'idle' }); return undefined; }
    let active = true;
    setCheck({ state: 'checking' });
    const timer = window.setTimeout(() => {
      runCheck(plate, selected.roomKey).then((result) => active && setCheck(result))
        .catch((e) => active && setCheck({ state: 'error', message: e instanceof Error ? e.message : '查重失败' }));
    }, 400);
    return () => { active = false; window.clearTimeout(timer); };
  }, [plate, runCheck, selected?.roomKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pmsRows = context?.rows || [];
  const liveRows = pmsRows.filter((row) => LIVE.includes(row.status));
  const pastRows = pmsRows.filter((row) => !LIVE.includes(row.status));
  const pmsPlates = new Set(pmsRows.filter((row) => LIVE.includes(row.status)).map((row) => row.plate));
  const legacyOnly = legacy.rows.filter((row) => !pmsPlates.has(legacyPlate(row)));
  const samePlateLive = pmsRows.find((row) => row.plate === plate && LIVE.includes(row.status) && !(source && row.id === source.id && row.status === 'active'));

  const infoOk = who === 'owner' || (carOwnerName.trim() && /^1\d{10}$/.test(carOwnerPhone.trim()) && relation);
  const garagesOk = garages.length > 0 && (!garages.includes('main') || !!garageNumbers.main?.trim()) && (!garages.includes('civil') || !!garageNumbers.civil?.trim());
  const ready = !!selected && check.state === 'ok' && !samePlateLive && infoOk && garagesOk;

  const save = async () => {
    if (!selected || !houseId || check.state !== 'ok') return;
    setSaving(true); setFormError('');
    try {
      let current = check;
      // 查重结果超过 4 分钟就重查一遍（服务端只认 5 分钟内的查重）
      if (Date.now() - current.at > 4 * 60 * 1000) {
        const fresh = await runCheck(plate, selected.roomKey);
        setCheck(fresh);
        if (fresh.state !== 'ok') return;
        current = fresh;
      }
      const result = await familyCars.create({
        houseId, plate, duplicateCheckQueryId: current.queryId, ownerFill: who === 'owner',
        carOwnerName: carOwnerName.trim(), carOwnerPhone: carOwnerPhone.trim(), relation, remark: remark.trim(),
        garages, garageNumbers: Object.fromEntries(Object.entries(garageNumbers).filter(([key]) => garages.includes(key))),
        previousId: source && source.plate === plate ? source.id : undefined,
      });
      message.success(who === 'owner' ? '已保存，二维码已生成' : '已保存，请上传资料');
      onCreated(result, result.qr, who === 'owner');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败');
    } finally { setSaving(false); }
  };

  const hint = !selected ? '请选择房号' : check.state !== 'ok' ? '请输入车牌并等待查重通过' : samePlateLive ? '该车牌已在办理中' : !infoOk ? '请填写车主信息，或选择由业主扫码填写' : !garagesOk ? '请选择开通车库并填写车库号' : who === 'owner' ? '保存后立即弹出二维码给业主扫' : '保存后进入资料上传';

  return <Drawer open width={1080} onClose={onClose} title={source ? `续登亲情车 · ${normalizePlate(source.plate)}` : '登记亲情车'} destroyOnClose
    footer={<div className="family-drawer-foot"><Text type="secondary">{hint}</Text><Space><Button onClick={onClose}>取消</Button><Button type="primary" size="large" disabled={!ready} loading={saving} onClick={() => void save()}>{who === 'owner' ? '保存并生成二维码' : '保存，下一步上传资料'}</Button></Space></div>}>
    {formError && <Alert type="error" showIcon closable message={formError} onClose={() => setFormError('')} style={{ marginBottom: 14 }} />}
    <div className="family-grid">
      <div>
        <section className="family-sec"><h3>1 · 业主地址</h3>
          <label className="family-label"><em>*</em>弄 / 号 / 室（可输入 228/6/502、业主姓名或电话）</label>
          <Select showSearch size="large" style={{ width: '100%' }} value={roomKeySel || undefined} loading={roomsLoading} placeholder={roomsLoading ? '正在读取 PMS 房号…' : '例如 228/6/502'}
            onChange={(value) => { setRoomKeySel(value || ''); setCheck({ state: 'idle' }); }} allowClear
            filterOption={(input, option) => !!option && String((option as { searchText?: string }).searchText || '').includes(input.trim().toLowerCase())}
            options={rooms.map((room) => ({ value: room.key, label: `${room.roomKey} · ${room.name}`, searchText: room.searchText }))} />
          {context && <div className="family-house"><div><span className="family-muted">{context.house.communityName} {context.house.lane} 弄 {context.house.buildingNo} 号 {context.house.roomNo} 室</span><br /><b>业主 {context.house.ownerName || '未登记'}</b> <Text type="secondary">{context.house.ownerPhone}</Text></div><Tag color="success">PMS 房产已匹配</Tag></div>}
        </section>
        <section className="family-sec"><h3>2 · 车辆与车主</h3>
          <div className="family-who">
            <button type="button" className={who === 'office' ? 'is-on' : ''} onClick={() => setWho('office')}><b>办公室现在填写</b><span>业主在柜台，口述即可</span></button>
            <button type="button" className={who === 'owner' ? 'is-on' : ''} onClick={() => setWho('owner')}><b>业主扫码时自己填</b><span>办公室只填车牌，审核时可修改</span></button>
          </div>
          <div className="family-2col">
            <div><label className="family-label"><em>*</em>车牌号</label>
              <Input value={plate} maxLength={10} onChange={(e) => setPlate(normalizePlate(e.target.value))} placeholder="豫GQ3N07" suffix={check.state === 'checking' ? <SyncOutlined spin /> : null} />
              <div className="family-hint">
                {!selected ? '先选择房号' : check.state === 'checking' ? '正在查询一期、二期停车库及德立云…'
                  : check.state === 'ok' ? <span className="family-ok">✓ {check.message}</span>
                    : check.state === 'conflict' || check.state === 'error' ? <span className="family-err">✗ {check.message}</span>
                      : plate && !plateValid(plate) ? <span className="family-err">车牌格式不正确</span> : '输入后自动查重'}
                {samePlateLive && <div className="family-err">✗ 该车牌已有亲情车登记（{samePlateLive.statusLabel}）</div>}
              </div>
            </div>
            <div><label className="family-label">{who === 'office' && <em>*</em>}与业主关系</label>
              <Select style={{ width: '100%' }} value={relation || undefined} disabled={who === 'owner'} placeholder={who === 'owner' ? '由业主填写' : '请选择'} onChange={setRelation} options={RELATIONS.map((value) => ({ value, label: value }))} /></div>
          </div>
          <div className="family-2col">
            <div><label className="family-label">{who === 'office' && <em>*</em>}车主姓名</label><Input value={carOwnerName} disabled={who === 'owner'} placeholder={who === 'owner' ? '由业主填写' : ''} onChange={(e) => setCarOwnerName(e.target.value)} maxLength={50} /></div>
            <div><label className="family-label">{who === 'office' && <em>*</em>}车主联系电话</label><Input value={carOwnerPhone} disabled={who === 'owner'} placeholder={who === 'owner' ? '由业主填写' : '11 位手机号'} onChange={(e) => setCarOwnerPhone(e.target.value.replace(/\s/g, ''))} maxLength={11} /></div>
          </div>
          <label className="family-label">备注</label><Input value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={200} />
        </section>
        <section className="family-sec"><h3>3 · 开通车库与有效期</h3>
          <div className="family-garages">{GARAGES.map((g) => <div key={g.key} className={`family-garage ${garages.includes(g.key) ? 'is-on' : ''}`}>
            <Checkbox checked={garages.includes(g.key)} onChange={(e) => setGarages((cur) => e.target.checked ? [...cur, g.key] : cur.filter((k) => k !== g.key))}>{g.label}</Checkbox>
            {(g.key === 'main' || g.key === 'civil') && garages.includes(g.key) && <Input size="small" placeholder={g.key === 'civil' ? '地库车位号（必填）' : '车库号（必填）'} value={garageNumbers[g.key] || ''} maxLength={20} onChange={(e) => setGarageNumbers((cur) => ({ ...cur, [g.key]: e.target.value }))} />}
          </div>)}</div>
          <div className="family-hint">{context ? `已按 ${context.house.lane} 弄自动选择，可调整。` : ''}</div>
          <Alert type="info" showIcon style={{ marginTop: 12 }} message="有效期 1 年，从物业经理审核通过、车库开通成功当天起算" description="到期前 30 天提醒，到期自动停用车库权限。亲情车办公室不收费。" />
        </section>
      </div>
      <div>
        <section className="family-sec"><h3>此户当前有效 / 办理中的亲情车 {context && <Tag color={liveRows.length >= 2 ? 'warning' : 'default'}>{liveRows.length} 辆</Tag>}</h3>
          {!context ? <div className="family-empty">选择地址后实时显示</div> : <>
            {liveRows.length >= 2 && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={`此户已有 ${liveRows.length} 辆有效 / 办理中的亲情车，再登记将超过 2 辆，请确认确有需要`} />}
            {liveRows.length ? <table className="family-mini"><thead><tr><th>车牌</th><th>车主 / 关系</th><th>状态</th><th>有效期至</th></tr></thead><tbody>
              {liveRows.map((row) => <tr key={row.id}><td><Plate value={row.plate} /></td><td>{row.carOwnerName || '—'} · {row.relation || '—'}</td><td><StatusTag row={row} /></td><td>{row.endDate || '—'}</td></tr>)}
            </tbody></table> : <div className="family-empty">此户暂无有效亲情车</div>}
          </>}
        </section>
        <section className="family-sec"><h3>旧停车库里的亲情车（未在本系统登记）</h3>
          {!context ? <div className="family-empty">选择地址后实时查询一期 / 二期旧库</div>
            : legacy.loading ? <div className="family-empty"><Spin size="small" /> 正在查询旧停车库…</div>
              : legacy.error ? <Alert type="warning" showIcon message="旧库查询失败" description={legacy.error} />
                : legacyOnly.length ? <table className="family-mini"><thead><tr><th>车牌</th><th>旧库</th><th>到期</th><th /></tr></thead><tbody>
                  {legacyOnly.map((row, i) => <tr key={`${legacyPlate(row)}-${i}`}><td><Plate value={legacyPlate(row)} /></td><td>{row.database === 'parking1' ? '一期' : '二期'}</td><td>{legacyEnd(row) || '—'}</td><td><Button size="small" type="link" onClick={() => setPlate(legacyPlate(row))}>补登记</Button></td></tr>)}
                </tbody></table> : <div className="family-empty">无</div>}
        </section>
        <section className="family-sec"><h3>历史亲情车记录 {context && <Text type="secondary" style={{ fontWeight: 400, fontSize: 13 }}>{pastRows.length} 条</Text>}</h3>
          {!context ? <div className="family-empty">选择地址后实时显示</div> : pastRows.length ? <table className="family-mini"><thead><tr><th>车牌</th><th>车主 / 关系</th><th>有效期</th><th /></tr></thead><tbody>
            {pastRows.map((row) => <tr key={row.id}><td><Plate value={row.plate} /></td><td>{row.carOwnerName || '—'} · {row.relation || '—'}</td><td className="family-muted">{row.startDate ? `${row.startDate} ~ ${row.endDate}` : row.statusLabel}</td>
              <td><Button size="small" type="link" onClick={() => { setPlate(row.plate); setCarOwnerName(row.carOwnerName); setCarOwnerPhone(row.carOwnerPhone); setRelation(row.relation); message.info('已带入，请核对；每年仍需重新上传资料并审核'); }}>带入</Button></td></tr>)}
          </tbody></table> : <div className="family-empty">无历史记录</div>}
        </section>
      </div>
    </div>
  </Drawer>;
}

/* ---------------- 详情 / 流程 ---------------- */
function stepIndex(status: string) {
  return ({ upload: 1, office: 2, returned: 2, manager: 3, opening: 4, active: 5, expired: 5, void: 5 } as Record<string, number>)[status] ?? 0;
}

function DetailDrawer({ id, canEdit, canApprove, onClose, onChanged, onShowQr, onRenew }: {
  id: number; canEdit: boolean; canApprove: boolean; onClose: () => void; onChanged: () => void; onShowQr: (qr: Qr) => void; onRenew: (row: Row) => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const [car, setCar] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [qr, setQr] = useState<Qr | null>(() => recallQr(id));
  const [editing, setEditing] = useState<null | { carOwnerName: string; carOwnerPhone: string; relation: string; remark: string }>(null);
  const [uploading, setUploading] = useState(false);
  const [newFiles, setNewFiles] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const now = useNow(!!qr);

  const refresh = useCallback(async () => {
    try {
      const next = await familyCars.detail(id);
      setCar((prev) => {
        if (prev && next.files.length > prev.files.length) setNewFiles(next.files.length - prev.files.length);
        if (prev && prev.status !== next.status) onChanged();
        return next;
      });
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '读取失败'); }
  }, [id, onChanged]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!car) return undefined;
    const fast = car.status === 'upload' || car.status === 'opening' || car.status === 'office';
    const timer = window.setInterval(() => void refresh(), fast ? 3000 : 10000);
    return () => window.clearInterval(timer);
  }, [car?.status, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<Detail & { qr?: Qr }>, ok: string, close = false) => {
    setBusy(true);
    try {
      const next = await fn();
      if (next.qr) { rememberQr(id, next.qr); setQr(next.qr); }
      setCar((prev) => ({ ...(prev || {}), ...next }) as Detail);
      message.success(ok); setNote(''); onChanged();
      if (close) onClose(); else void refresh();
    } catch (e) { message.error(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };

  const addFiles = async (files: File[]) => {
    if (!files.length || !car) return;
    if (files.some((file) => file.size > 20 * 1024 * 1024)) { message.error('每份资料不能超过 20MB'); return; }
    setUploading(true);
    try { const next = await uploadFiles(car.id, files.slice(0, 10)); setCar((prev) => ({ ...(prev || {}), ...next }) as Detail); message.success(`已上传 ${Math.min(files.length, 10)} 份`); }
    catch (e) { message.error(e instanceof Error ? e.message : '上传失败'); }
    finally { setUploading(false); }
  };

  // Ctrl+V 粘贴：页面上只有这一个上传区，粘贴目标明确
  useEffect(() => {
    if (!car || car.status !== 'upload' || !canEdit) return undefined;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) { event.preventDefault(); void addFiles(files); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [car?.status, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!car) return <Drawer open width={1080} onClose={onClose} title="亲情车">{error ? <Alert type="error" showIcon message={error} /> : <Spin />}</Drawer>;

  const status = car.status;
  const step = stepIndex(status);
  const qrValid = qr && new Date(qr.expiresAt).getTime() > now && car.upload?.id === qr.id;
  const uploadStatus = car.upload?.id === qr?.id ? car.upload?.status : undefined;
  const opStates = car.operationStates;
  const registrationFailed = opStates?.registration?.status === 'failed';

  const info = <section className="family-sec"><h3>登记信息 {canEdit && ['upload', 'office', 'returned'].includes(status) && !editing && <Button size="small" type="link" onClick={() => setEditing({ carOwnerName: car.carOwnerName, carOwnerPhone: car.carOwnerPhone, relation: car.relation, remark: car.remark })}>修改</Button>}</h3>
    {editing ? <div>
      <div className="family-2col">
        <div><label className="family-label">车主姓名</label><Input value={editing.carOwnerName} onChange={(e) => setEditing({ ...editing, carOwnerName: e.target.value })} /></div>
        <div><label className="family-label">车主联系电话</label><Input value={editing.carOwnerPhone} onChange={(e) => setEditing({ ...editing, carOwnerPhone: e.target.value })} /></div>
      </div>
      <div className="family-2col">
        <div><label className="family-label">与业主关系</label><Select style={{ width: '100%' }} value={editing.relation || undefined} onChange={(relation) => setEditing({ ...editing, relation })} options={RELATIONS.map((value) => ({ value, label: value }))} /></div>
        <div><label className="family-label">备注</label><Input value={editing.remark} onChange={(e) => setEditing({ ...editing, remark: e.target.value })} /></div>
      </div>
      <Space><Button onClick={() => setEditing(null)}>取消</Button><Button type="primary" loading={busy} onClick={() => void run(() => familyCars.update(car.id, editing), '已保存').then(() => setEditing(null))}>保存</Button></Space>
    </div> : <table className="family-kv"><tbody>
      <tr><td>地址</td><td>{car.lane} 弄 {car.buildingNo} 号 {car.roomNo} 室 · 业主 {car.ownerName || '—'} {car.ownerPhone}</td><td>车牌号</td><td><Plate value={car.plate} /></td></tr>
      <tr><td>车主姓名</td><td>{car.carOwnerName || <Text type="secondary">待业主填写</Text>}</td><td>联系电话</td><td>{car.carOwnerPhone || <Text type="secondary">待业主填写</Text>}</td></tr>
      <tr><td>与业主关系</td><td>{car.relation || <Text type="secondary">待业主填写</Text>}</td><td>开通车库</td><td>{car.garages.map((g) => GARAGE_LABEL[g] + (car.garageNumbers[g] ? `（${car.garageNumbers[g]}）` : '')).join('、')}</td></tr>
      <tr><td>办理方式</td><td>{car.mode === 'new' ? '新车牌：旧库先暂存待审核，通过后开通' : '旧库已是本户亲情车：通过后重新授权并续期'}</td><td>备注</td><td>{car.remark || '—'}</td></tr>
    </tbody></table>}
  </section>;

  const filesSec = <section className="family-sec"><h3>资料 <Text type="secondary" style={{ fontWeight: 400, fontSize: 13 }}>{car.files.length} 份{newFiles > 0 ? `（新收到 ${newFiles} 份）` : ''}</Text></h3>
    {car.files.length ? <Image.PreviewGroup><div className="family-files">{car.files.map((file) => <div key={file.index} className="family-file">
      <span className="family-file-src">{file.source === 'owner' ? '业主扫码' : '办公室'}</span>
      {file.contentType === 'application/pdf' ? <a className="family-file-pdf" href={file.fileUrl} target="_blank" rel="noreferrer">PDF</a> : <Image src={file.fileUrl} width="100%" height={104} style={{ objectFit: 'cover' }} />}
      <div className="family-file-name"><span title={file.fileName}>{file.fileName}</span>{canEdit && status === 'upload' && <a onClick={() => void run(() => familyCars.removeFile(car.id, file.index), '已删除')}>删除</a>}</div>
    </div>)}</div></Image.PreviewGroup> : <div className="family-empty">还没有资料。业主扫码上传后会自动出现在这里，无需刷新。</div>}
  </section>;

  const logSec = <section className="family-sec"><h3>处理记录</h3><div className="family-tl">{car.log.map((entry, index) => <div key={index} className={index === car.log.length - 1 ? 'is-last' : ''}>
    {entry.action}{entry.note ? `：${entry.note}` : ''}<small>{entry.userName} · {dayjs(entry.at).format('MM-DD HH:mm')}</small></div>)}</div></section>;

  let body: React.ReactNode;
  let foot: React.ReactNode = <Button onClick={onClose}>关闭</Button>;

  if (status === 'upload') {
    body = <>
      {registrationFailed && <Alert type="error" showIcon style={{ marginBottom: 14 }} message="旧库暂存失败" description={`${opStates?.registration?.error || ''}。请作废后重新登记。`} />}
      {opStates?.registration && ['pending', 'running'].includes(opStates.registration.status) && <Alert type="info" showIcon style={{ marginBottom: 14 }} message="正在旧停车库暂存待审核车辆（零授权，不开通）" description="需要现场停车网关在线；不影响上传资料。" />}
      <div className="family-2col family-2col-wide">
        <section className="family-sec"><h3>方式一 · 办公室本地上传</h3>
          <div className={`family-drop ${uploading ? 'is-busy' : ''}`} tabIndex={0} role="button"
            onClick={() => canEdit && fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (canEdit) void addFiles(Array.from(e.dataTransfer.files)); }}>
            <b>{uploading ? '正在上传…' : '点击选择、拖入文件，或 Ctrl+V 粘贴截图'}</b>照片或 PDF，不分项，可传多份（行驶证、身份证、户口本、关系证明等）
          </div>
          <input ref={fileInput} type="file" multiple hidden accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,application/pdf" onChange={(e) => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
          <div className="family-hint">当前粘贴目标：本条亲情车资料</div>
        </section>
        <section className="family-sec"><h3>方式二 · 业主扫码自助上传</h3>
          {qrValid && qr ? <div className="family-qr-row">
            <img src={qr.qrDataUrl} alt="上传二维码" className="family-qr-small" />
            <div>
              <div>{uploadStatus === 'opened' ? <Tag color="processing">业主已打开页面，正在填写…</Tag> : uploadStatus === 'submitted' ? <Tag color="success">业主已提交</Tag> : <Tag color="warning">等待业主扫码</Tag>}</div>
              <div className="family-count">{countdown(qr.expiresAt, now)}</div>
              <div className="family-hint">{car.ownerFill ? '车主信息由业主在手机上填写；' : ''}提交后这里自动显示（约 3 秒内）</div>
              <Space wrap><Button type="primary" icon={<QrcodeOutlined />} onClick={() => onShowQr(qr)}>放大给业主扫</Button>
                <Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard?.writeText(qr.url); message.success('链接已复制，可粘贴到微信发给业主'); }}>复制链接</Button>
                {canEdit && <Button loading={busy} onClick={() => void run(() => familyCars.regenerateQr(car.id), '已重新生成，旧二维码已失效')}>重新生成</Button>}</Space>
            </div>
          </div> : <div className="family-empty">
            {car.upload && car.upload.status !== 'expired' && car.upload.status !== 'submitted' ? '二维码已发出但不在本浏览器，可重新生成（旧二维码会失效）' : '生成一个 1 小时有效的临时二维码，业主扫码填写车主信息并上传资料'}
            <br /><br />{canEdit && <Button type="primary" icon={<QrcodeOutlined />} loading={busy} onClick={() => void run(async () => { const next = await familyCars.regenerateQr(car.id); onShowQr(next.qr); return next; }, '二维码已生成')}>生成二维码</Button>}
          </div>}
        </section>
      </div>
      {filesSec}{info}{logSec}
    </>;
    if (canEdit) foot = <><Text type="secondary" className="family-foot-tip">资料齐了即可提交审核；业主扫码提交后会自动进入办公室审核</Text>
      <Button danger onClick={() => voidConfirm()}>作废登记</Button>
      <Button type="primary" size="large" disabled={!car.files.length} loading={busy} onClick={() => void run(() => familyCars.submit(car.id), '已提交办公室审核')}>提交办公室审核</Button></>;
  } else if (status === 'office' || status === 'returned' || status === 'manager') {
    const isOffice = status !== 'manager';
    const can = isOffice ? canEdit : canApprove;
    body = <div className="family-grid">
      <div>
        {status === 'returned' && <Alert type="error" showIcon style={{ marginBottom: 14 }} message={`物业经理退回：${car.managerNote}`} description="可以要求业主补资料，或补充说明后重新提交经理审核。" />}
        {filesSec}{info}
      </div>
      <div>
        <section className="family-sec"><h3>审核意见</h3>
          {car.officeReviewedAt && <div className="family-opinion"><b>办公室</b> <Text type="secondary">{dayjs(car.officeReviewedAt).format('MM-DD HH:mm')}</Text><br />{car.officeNote}</div>}
          {car.managerReviewedAt && status === 'returned' && <div className="family-opinion is-bad"><b>物业经理（退回）</b> <Text type="secondary">{dayjs(car.managerReviewedAt).format('MM-DD HH:mm')}</Text><br />{car.managerNote}</div>}
          {can ? <><label className="family-label">{isOffice ? '办公室' : '经理'}意见（{isOffice ? '作废' : '退回'}时必填）</label><Input.TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={isOffice ? '例如：资料齐全，户口本可证明关系' : '例如：同意'} /></>
            : <Alert type="info" showIcon message={isOffice ? '等待办公室审核' : '等待物业经理审核；经理也可以在员工小程序「审批」里处理'} />}
        </section>
        {logSec}
      </div>
    </div>;
    if (can && isOffice) foot = <><Text type="secondary" className="family-foot-tip">通过后进入物业经理审核，并提醒经理</Text>
      <Button danger onClick={() => voidConfirm()}>驳回并作废</Button>
      <Button loading={busy} onClick={() => void run(() => familyCars.officeReview(car.id, 'reupload', note), '已退回资料上传，并生成新二维码')}>要求业主补资料</Button>
      <Button type="primary" size="large" loading={busy} onClick={() => void run(() => familyCars.officeReview(car.id, 'approve', note), '已提交物业经理审核', true)}>{status === 'returned' ? '重新提交经理审核' : '审核通过'}</Button></>;
    else if (can) foot = <><Text type="secondary" className="family-foot-tip">通过后自动开通车库并续期一年，有效期从今天起算</Text>
      <Button danger loading={busy} onClick={() => { if (!note.trim()) { message.warning('请填写退回原因'); return; } void run(() => familyCars.managerReview(car.id, 'return', note), '已退回办公室', true); }}>退回办公室</Button>
      <Button type="primary" size="large" loading={busy} onClick={() => void run(() => familyCars.managerReview(car.id, 'approve', note), '审核通过，开始开通车库')}>审核通过并开通</Button></>;
  } else if (status === 'opening') {
    const item = (label: string, state?: familyCars.FamilyCarOperationState | null, waiting?: string) => <div className="family-prog">
      <b>{label}</b><span>{!state ? (waiting || '排队中') : state.status === 'completed' ? <Text type="success">✓ 已写入并读回确认</Text> : state.status === 'failed' ? <Text type="danger">✗ {state.error}</Text> : <><SyncOutlined spin /> 执行中…</>}</span></div>;
    body = <>
      <section className="family-sec"><h3>正在调用停车模块开通（有效期 {car.startDate} ~ {car.endDate}）</h3>
        {item(`车库授权：${car.garages.filter((g) => g !== 'civil').map((g) => GARAGE_LABEL[g]).join('、') || '—'}`, opStates?.open, car.lastError || '等待停车网关')}
        {item('续期一年（停车续期，不收费）', opStates?.renew, '车库授权完成后自动续期')}
        {car.garages.includes('civil') && item('二期人防车库（德立云）', opStates?.civil)}
        {car.lastError && <Alert type="error" showIcon style={{ marginTop: 10 }} message={car.lastError} description="只重试失败的那一步，不会重复登记。" />}
        <Alert type="info" showIcon style={{ marginTop: 10 }} message="复用停车管理的下发任务，结果以旧库读回为准；可以关闭窗口，开通在后台继续。" />
      </section>
      {info}{logSec}
    </>;
    foot = <>{(canEdit || canApprove) && car.lastError && <Button type="primary" loading={busy} onClick={() => void run(() => familyCars.retry(car.id), '已重试')}>重试失败的步骤</Button>}<Button onClick={onClose}>后台继续</Button></>;
  } else {
    body = <>
      {status === 'active' && <div className="family-done"><div className="family-done-ic">✓</div><h2>亲情车已生效</h2><Text type="secondary">{car.plate} 已开通 {car.garages.map((g) => GARAGE_LABEL[g]).join('、')}<br />有效期 {car.startDate} ~ {car.endDate}{car.daysLeft !== null ? `，剩余 ${car.daysLeft} 天` : ''}；到期前 30 天提醒</Text></div>}
      {status === 'expired' && <Alert type="warning" showIcon style={{ marginBottom: 14 }} message={`已于 ${car.endDate || '—'} 到期 / 停用`} description="如需继续使用，请「续登」：带入原信息，重新上传资料并审核。" />}
      {status === 'void' && <Alert type="info" showIcon style={{ marginBottom: 14 }} message="该登记已作废" />}
      <div className="family-grid"><div>{info}{filesSec}</div><div>{logSec}</div></div>
    </>;
    foot = <>{canEdit && status === 'active' && <Button danger onClick={() => stopConfirm()}>提前停用</Button>}
      {canEdit && (status === 'expired' || (status === 'active' && car.expiringSoon)) && <Button type="primary" onClick={() => onRenew(car)}>续登</Button>}
      <Button onClick={onClose}>关闭</Button></>;
  }

  function voidConfirm() {
    let reason = '';
    modal.confirm({
      title: '作废这条亲情车登记？', okText: '确认作废', okButtonProps: { danger: true },
      content: <Input.TextArea rows={3} placeholder="作废原因（必填）" onChange={(e) => { reason = e.target.value; }} />,
      onOk: async () => { if (!reason.trim()) { message.warning('请填写作废原因'); throw new Error('reason'); } await run(() => familyCars.officeReview(car!.id, 'void', reason), '已作废', true); },
    });
  }
  function stopConfirm() {
    let reason = '';
    modal.confirm({
      title: '提前停用将立即撤销车库授权，确认？', okText: '确认停用', okButtonProps: { danger: true },
      content: <Input.TextArea rows={3} placeholder="停用原因（必填）" onChange={(e) => { reason = e.target.value; }} />,
      onOk: async () => { if (!reason.trim()) { message.warning('请填写停用原因'); throw new Error('reason'); } await run(() => familyCars.stop(car!.id, reason), '已停用'); },
    });
  }

  return <Drawer open width={1080} onClose={onClose} destroyOnClose
    title={<div className="family-dh"><span><Plate value={car.plate} /> {car.lane}/{car.buildingNo}/{car.roomNo} {car.ownerName}</span><StatusTag row={car} /></div>}
    footer={<div className="family-drawer-foot is-right">{foot}</div>}>
    <Steps size="small" className="family-steps" current={step} status={status === 'returned' || (status === 'opening' && car.lastError) ? 'error' : status === 'active' ? 'finish' : 'process'}
      items={['登记', '资料上传', '办公室审核', '经理审核', '开通车库', '完成'].map((title) => ({ title }))} />
    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
    {body}
  </Drawer>;
}


/* ---------------- 从停车库导入 ---------------- */

const IMPORT_HEADER = '车牌 房号 车主姓名 电话 旧库身份 到期日';

/** 一行一条。支持从 Excel 直接复制（制表符）或手打逗号/空格分隔 */
function parseImportText(text: string): Array<familyCars.ImportFamilyCarRow> {
  const rows: Array<familyCars.ImportFamilyCarRow> = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('车牌')) continue;
    let cells = raw.split(/[\t,，;；|]+/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) cells = raw.split(/\s{1,}/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const [plate, room, ownerName, ownerPhone, identity, endDate] = cells;
    rows.push({
      plate,
      room,
      ownerName: ownerName || undefined,
      ownerPhone: ownerPhone || undefined,
      identity: identity || undefined,
      endDate: endDate || undefined,
      remark: '从停车库导入',
    });
  }
  return rows;
}

const VERDICT_LABEL: Record<string, { text: string; color: string }> = {
  imported: { text: '已导入', color: 'green' },
  would_import: { text: '可导入', color: 'blue' },
  skipped: { text: '跳过', color: 'orange' },
  failed: { text: '失败', color: 'red' },
};

function ImportFamilyCarsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<familyCars.ImportFamilyCarResult | null>(null);
  const parsed = useMemo(() => parseImportText(text), [text]);

  const run = async (dryRun: boolean) => {
    if (!parsed.length) { message.warning('先粘贴要导入的亲情车清单'); return; }
    setBusy(true);
    try {
      const res = await familyCars.importFromParking(parsed, dryRun);
      setResult(res);
      const ok = res.rows.filter((row) => row.verdict === 'imported' || row.verdict === 'would_import').length;
      if (dryRun) message.success(`核对完成：可导入 ${ok} 条，跳过 ${res.summary.skipped} 条，失败 ${res.summary.failed} 条`);
      else {
        message.success(`已导入 ${res.summary.imported} 条，跳过 ${res.summary.skipped} 条，失败 ${res.summary.failed} 条`);
        onDone();
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const canImport = !!result?.dryRun && result.rows.some((row) => row.verdict === 'would_import');

  return <Modal open width={880} title="从停车库导入亲情车" onCancel={onClose} destroyOnClose
    footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Button onClick={onClose}>取消</Button>
      <Button onClick={() => void run(true)} loading={busy}>核对</Button>
      <Button type="primary" disabled={!canImport} loading={busy} onClick={() => void run(false)}>确认导入</Button>
    </div>}>
    <Alert type="info" showIcon style={{ marginBottom: 12 }}
      message="这些车在停车系统里已经在用，导入后状态直接记为「已生效」，不再走两级审核；PMS 里没有照片资料，日志会写明来源。" />
    <Input.TextArea rows={7} value={text} onChange={(e) => setText(e.target.value)}
      placeholder={`每行一条，从 Excel 复制即可（列顺序：${IMPORT_HEADER}）` +
        `\n例：豫GQ3N07\t228/6/502\t周丽华\t13800002231\t亲情车\t2027-06-30`} />
    <div style={{ margin: '8px 0 12px', color: 'rgba(0,0,0,.45)', fontSize: 13 }}>
      已识别 {parsed.length} 行；房号支持 228/6/502、228弄6号502室、6/502 三种写法。
    </div>
    {result && <>
      <div style={{ marginBottom: 8 }}>
        共 {result.summary.total} 条：可导入/已导入 {result.rows.filter((row) => row.verdict === 'imported' || row.verdict === 'would_import').length}，
        跳过 {result.summary.skipped}，失败 {result.summary.failed}
      </div>
      <Table size="small" rowKey={(row, index) => `${row.plate}-${index}`} dataSource={result.rows} pagination={{ pageSize: 10 }}
        columns={[
          { title: '车牌', dataIndex: 'plate', width: 120 },
          { title: '房号', dataIndex: 'room', width: 140 },
          { title: '结果', dataIndex: 'verdict', width: 90, render: (v: string) => <Tag color={VERDICT_LABEL[v]?.color}>{VERDICT_LABEL[v]?.text || v}</Tag> },
          { title: '说明', dataIndex: 'message' },
        ]} />
    </>}
  </Modal>;
}
