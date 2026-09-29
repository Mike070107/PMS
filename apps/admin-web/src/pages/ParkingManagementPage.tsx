import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CalendarOutlined,
  CarOutlined,
  DatabaseOutlined,
  CopyOutlined,
  EditOutlined,
  HomeOutlined,
  PhoneOutlined,
  PlusOutlined,
  ReloadOutlined,
  QrcodeOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  accessCardIssuance,
  type AccessCardReadiness,
} from '@pms/api-client';
import { useCallback, useEffect, useState } from 'react';
import OwnerFormModal, { type OwnerRow } from './OwnerFormModal';
import './ParkingManagementPage.css';

const { Text, Title } = Typography;
type ParkingQueryRow = accessCardIssuance.ParkingQueryRow;

export default function ParkingManagementPage({
  readinessOverride,
  rowsOverride,
}: {
  readinessOverride?: AccessCardReadiness;
  rowsOverride?: ParkingQueryRow[];
} = {}) {
  const { message } = AntdApp.useApp();
  const [readiness, setReadiness] = useState<AccessCardReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [gatewayName, setGatewayName] = useState('枫桦景苑停车系统网关');
  const [enrolling, setEnrolling] = useState(false);
  const [credential, setCredential] = useState<{ id: string; token: string; message: string } | null>(null);
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [rows, setRows] = useState<ParkingQueryRow[]>([]);
  const [searchedTerm, setSearchedTerm] = useState('');
  const [proofUpload, setProofUpload] = useState<accessCardIssuance.ParkingProofUpload | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [editingPmsOwner, setEditingPmsOwner] = useState<OwnerRow | undefined>();

  const loadReadiness = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setReadiness(readinessOverride ?? await accessCardIssuance.readiness());
    } catch (error) {
      if (!silent) message.error(error instanceof Error ? error.message : '停车网关状态加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [message, readinessOverride]);

  useEffect(() => { void loadReadiness(); }, [loadReadiness]);

  useEffect(() => {
    if (readinessOverride) return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadReadiness(true);
    };
    const timer = window.setInterval(refreshWhenVisible, 5_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadReadiness, readinessOverride]);

  const enrollGateway = async () => {
    if (!gatewayName.trim()) {
      message.error('请填写这台电脑的名称');
      return;
    }
    setEnrolling(true);
    try {
      const result = await accessCardIssuance.enrollAgent({ kind: 'parking_gateway', name: gatewayName.trim() });
      setCredential(result);
      await loadReadiness();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停车网关注册失败');
    } finally {
      setEnrolling(false);
    }
  };

  const parkingGateways = readiness?.agents.filter((item) => item.kind === 'parking_gateway') ?? [];
  const gateway = parkingGateways.find((item) => item.status === 'online')
    ?? [...parkingGateways].sort((left, right) =>
      new Date(right.lastSeenAt ?? 0).getTime() - new Date(left.lastSeenAt ?? 0).getTime())[0];
  const online = gateway?.status === 'online';
  const canRead = online && readiness?.features.parkingDbRead === true;
  // 0.4.0 已能查询 Car_Issue；0.4.1 增加住户表联查，不能因为住户增强尚未升级就把整条查询锁死。
  const canQuery = canRead;
  const canJoinOwners = supportsParkingQueries(gateway?.version);
  const canWriteLocal = online && gateway?.capabilities?.parkingDbWrite === true;
  const deliyun = readiness?.deliyun;

  const searchParking = async () => {
    const queryTerm = term.trim();
    if (queryTerm.length < 2) {
      message.error('请输入至少 2 个字符，可输入房号、住户或车牌');
      return;
    }
    setSearching(true);
    setRows([]);
    setSearchedTerm(queryTerm);
    try {
      if (rowsOverride) {
        setRows(rowsOverride);
        return;
      }
      let query = await accessCardIssuance.createParkingQuery(queryTerm);
      for (let attempt = 0; attempt < 90 && (query.status === 'pending' || query.status === 'running'); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        query = await accessCardIssuance.parkingQuery(query.id);
      }
      if (query.status === 'completed') {
        setRows(query.rows);
        if (query.rows.length === 0) message.info(`没有查到与“${queryTerm}”匹配的停车记录`);
      } else if (query.status === 'failed') {
        throw new Error(query.error || '停车数据库查询失败');
      } else {
        throw new Error('停车网关响应超时，请确认现场电脑仍在线后重试');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停车数据查询失败');
    } finally {
      setSearching(false);
    }
  };

  const createProofUpload = async (row: ParkingQueryRow) => {
    setProofLoading(true);
    try {
      const upload = await accessCardIssuance.createParkingProofUpload({
        plate: plateValue(row.fields),
        ownerId: fieldValue(row.fields, fieldAliases.ownerId) || undefined,
      });
      setProofUpload(upload);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '临时上传二维码生成失败');
    } finally {
      setProofLoading(false);
    }
  };

  useEffect(() => {
    if (!proofUpload || proofUpload.status === 'submitted') return undefined;
    const timer = window.setInterval(async () => {
      try {
        const next = await accessCardIssuance.parkingProofUpload(proofUpload.id);
        setProofUpload((current) => current?.id === next.id ? { ...current, ...next } : current);
      } catch { /* 二维码弹窗仍可使用；短暂轮询失败不打断现场操作。 */ }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [proofUpload?.id, proofUpload?.status]);

  return (
    <div className="parking-page parking-live-page">
      <section className="parking-hero parking-live-hero">
        <div>
          <div className="parking-eyebrow"><SafetyCertificateOutlined /> 生产环境 · 仅展示真实连接状态</div>
          <Title level={1}>停车管理</Title>
          <Text>停车住户、车辆、车位和到期数据只从已验证的真实数据源读取，不使用演示数据。</Text>
        </div>
        <div className="parking-live-status">
          <span className={online ? 'is-online' : ''}><DatabaseOutlined /></span>
          <div><small>停车网关</small><strong>{online ? '已连接' : '未连接'}</strong></div>
        </div>
      </section>

      <Alert
        type={canQuery ? 'success' : 'warning'}
        showIcon
        message={canQuery ? '停车数据库真实查询已就绪' : '尚未接通真实停车数据'}
        description={canQuery
          ? `查询会实时读取现场一期、二期 Car_Issue 表；当前仍为只读，不会修改旧系统。${canJoinOwners ? '住户表联查已启用。' : `当前助手 ${gateway?.version || '未知版本'} 可查车辆，升级 0.4.1 后还能按住户姓名、电话和房号联查。`}`
          : '请先在下方注册并安装 Windows 本地停车网关。连接完成前不会显示任何模拟住户、车牌、车位或收费记录。'}
      />

      <Card className="parking-device-card" variant="borderless">
        <div className="parking-device-heading">
          <div>
            <span className="parking-section-kicker">设备与服务</span>
            <Title level={3}>Windows 本地停车网关</Title>
            <Text type="secondary">连接一期、二期停车旧库；数据库密码只在现场电脑加密保存。</Text>
          </div>
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReadiness()}>重新检测</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setCredential(null); setModalOpen(true); }}>注册停车网关</Button>
          </Space>
        </div>
        <div className="parking-device-status">
          <span className={`parking-device-icon is-${online ? 'online' : 'offline'}`}><DatabaseOutlined /></span>
          <div>
            <strong>{gateway?.name || '尚未连接停车网关'}</strong>
            <small>{gateway
              ? `版本 ${gateway.version} · 最近心跳 ${gateway.lastSeenAt ? new Date(gateway.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '暂无'}`
              : '安装数据同步助手并完成一次性密钥绑定后显示真实状态'}</small>
          </div>
          <Tag color={online ? 'success' : 'default'}>{online ? '在线' : '未连接'}</Tag>
          <div className="parking-device-databases">
            <Tag color={canQuery ? 'success' : 'default'} icon={canQuery ? <CheckCircleOutlined /> : <DatabaseOutlined />}>
              枫桦景苑一期 {canQuery ? '已连接' : '未验证'}
            </Tag>
            <Tag color={canQuery ? 'success' : 'default'} icon={canQuery ? <CheckCircleOutlined /> : <DatabaseOutlined />}>
              枫桦景苑二期 {canQuery ? '已连接' : '未验证'}
            </Tag>
            <Tag color={canQuery ? 'success' : 'default'}>{canQuery ? '车辆查询已就绪' : '尚未验证'}</Tag>
            <Tag color={canJoinOwners ? 'success' : 'gold'}>{canJoinOwners ? '住户联查已启用' : '升级后联查住户'}</Tag>
            <Tag color={canWriteLocal ? 'success' : 'gold'}>{canWriteLocal ? '受控写入测试已开放' : '写入权限未通过'}</Tag>
          </div>
        </div>
        <div className={`parking-cloud-status is-${deliyun?.connected ? 'online' : 'pending'}`}>
          <span className="parking-device-icon"><SafetyCertificateOutlined /></span>
          <div>
            <strong>德立云 · 二期人防车库</strong>
            <small>{deliyun?.message || '正在读取德立云连接状态'}</small>
          </div>
          <Tag color={deliyun?.connected ? 'success' : deliyun?.configured ? 'gold' : 'default'}>
            {deliyun?.connected ? '只读已连接' : deliyun?.configured ? '配置待补充' : '未配置'}
          </Tag>
          <Tag>写入未开放</Tag>
        </div>
      </Card>

      <Card className="parking-resident-card parking-live-search" variant="borderless">
        <div className="parking-resident-search">
          <div>
            <span className="parking-section-kicker">真实数据查询</span>
            <Title level={3}>查找房号、住户或车牌</Title>
            <Text type="secondary">支持 228/5/301、198-5-201、住户姓名、电话或完整车牌。</Text>
          </div>
          <Input.Search
            value={term}
            disabled={!canQuery}
            loading={searching}
            enterButton="查询"
            prefix={<SearchOutlined />}
            placeholder={canQuery ? '输入房号、住户、电话或车牌' : '升级并连接网关后开放查询'}
            aria-label="查找房号、住户、电话或车牌"
            onChange={(event) => setTerm(event.target.value)}
            onSearch={() => void searchParking()}
          />
        </div>
        {searching ? (
          <div className="parking-query-loading"><Spin /><span>正在查询一期、二期停车数据库…</span></div>
        ) : rows.length > 0 ? (
          <div className="parking-query-results">
            <div className="parking-query-summary">
              <CheckCircleOutlined /> 找到 {rows.length} 条真实记录，其中 {rows.filter((row) => row.pmsMatch).length} 条已关联 PMS 用户
            </div>
            {rows.map((row, index) => <ParkingResultCard
              key={`${row.database}-${index}`}
              row={row}
              canWriteLocal={canWriteLocal}
              proofLoading={proofLoading}
              onCreateProof={() => void createProofUpload(row)}
              onEditPms={(owner) => setEditingPmsOwner(owner)}
            />)}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={searchedTerm
              ? `没有查到与“${searchedTerm}”匹配的停车记录`
              : canQuery ? '输入房号、住户、电话或车牌开始查询' : '未连接真实停车数据库，不显示模拟数据'}
          />
        )}
      </Card>

      <Modal
        title="注册停车系统本地网关"
        open={modalOpen}
        width={650}
        onCancel={() => setModalOpen(false)}
        footer={credential
          ? <Button type="primary" onClick={() => setModalOpen(false)}>我已保存安装信息</Button>
          : <Space><Button onClick={() => setModalOpen(false)}>取消</Button><Button type="primary" loading={enrolling} onClick={() => void enrollGateway()}>生成一次性密钥</Button></Space>}
      >
        {credential ? (
          <div className="parking-gateway-secret">
            <Alert type="warning" showIcon message="密钥只显示这一次" description={credential.message} />
            <label>代理 ID</label><pre>{credential.id}</pre>
            <label>一次性代理密钥</label><pre>{credential.token}</pre>
            <Text type="secondary">在停车系统电脑运行：</Text>
            <pre>{`.\\Pms.AccessCardAgent.exe --install-agent ${credential.id}`}</pre>
            <Text type="secondary">粘贴密钥后，再运行 <code>.\Pms.AccessCardAgent.exe --parking-probe</code> 检查 parking1、parking2。</Text>
          </div>
        ) : (
          <div className="parking-gateway-form">
            <Alert type="info" showIcon message="服务类型固定为停车系统网关" description="一次性密钥由 PMS 生成，数据库密码不会上传到 PMS。" />
            <label htmlFor="parking-gateway-name">电脑名称</label>
            <Input id="parking-gateway-name" value={gatewayName} maxLength={100} onChange={(event) => setGatewayName(event.target.value)} />
          </div>
        )}
      </Modal>
      <OwnerFormModal
        open={!!editingPmsOwner}
        target={editingPmsOwner}
        onClose={() => setEditingPmsOwner(undefined)}
        onDone={() => { setEditingPmsOwner(undefined); void searchParking(); }}
      />

      <Modal
        title={`亲情车证明材料 · ${proofUpload?.plate || ''}`}
        open={!!proofUpload}
        footer={<Button type="primary" onClick={() => setProofUpload(null)}>关闭</Button>}
        onCancel={() => setProofUpload(null)}
      >
        {proofUpload && (
          <div className="parking-proof-modal">
            {proofUpload.status === 'submitted' ? (
              <Alert type="success" showIcon message="证明材料已上传" description={proofUpload.fileName || '手机端已经提交，办公室可以继续办理亲情车。'} />
            ) : (
              <Alert type={proofUpload.status === 'opened' ? 'info' : 'warning'} showIcon message={proofUpload.status === 'opened' ? '用户已打开上传页面' : '等待用户扫码'} description="二维码 30 分钟有效，只能为当前车牌提交一次图片或 PDF。" />
            )}
            {proofUpload.qrDataUrl && <img src={proofUpload.qrDataUrl} alt="亲情车证明材料临时上传二维码" />}
            <Text type="secondary">{new Date(proofUpload.expiresAt).toLocaleString('zh-CN', { hour12: false })} 前有效</Text>
          </div>
        )}
      </Modal>
    </div>
  );
}

function supportsParkingQueries(version?: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) > 4 || (Number(match[2]) === 4 && Number(match[3]) >= 1)));
}

const fieldAliases = {
  plate: ['carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌'],
  owner: ['ownername', 'carname', 'username', 'customername', 'personname', '姓名', '车主', '住户'],
  room: ['roomno', 'roomnumber', 'houseno', 'address', 'addr', 'room', '房号', '地址'],
  phone: ['mobile', 'telephone', 'phone', 'tel', '手机', '电话'],
  space: ['parkno', 'parkingno', 'spaceno', 'berth', 'garage', '车位', '地库'],
  expiry: ['enddate', 'expiredate', 'expirydate', 'validto', 'deadline', 'overdate', 'endtime', '到期', '有效期'],
  identity: ['carbrand', 'carbeand', 'vehicleidentity', 'caridentity', 'ownertype', 'usertype', 'relationtype', 'carlei', '车辆身份', '车辆类型', '车类', '身份', '性质'],
  note: ['pnote', 'remark', 'remarks', 'note', '备注'],
  effective: ['peffective'],
  download: ['pdownload'],
  ownerId: ['ownerid', '住户编号', '业主编号'],
} as const;

function normalizeFieldName(value: string) {
  return value.toLowerCase().replace(/[\s_\-./]/g, '');
}

function fieldValue(fields: ParkingQueryRow['fields'], aliases: readonly string[]): string | null {
  const entries = Object.entries(fields).filter(([, value]) => value !== null && String(value).trim() !== '');
  for (const alias of aliases) {
    const exact = entries.find(([key]) => normalizeFieldName(key) === alias);
    if (exact) return String(exact[1]);
  }
  for (const alias of aliases) {
    const partial = entries.find(([key]) => normalizeFieldName(key).includes(alias));
    if (partial) return String(partial[1]);
  }
  return null;
}

function plateValue(fields: ParkingQueryRow['fields']): string {
  const named = fieldValue(fields, fieldAliases.plate);
  if (named) return named;
  const detected = Object.values(fields).find((value) => typeof value === 'string' && /^[\u4e00-\u9fff][A-Z][A-Z0-9挂学警港澳]{5,6}$/i.test(value.trim()));
  return detected ? String(detected) : '车牌字段待识别';
}

function vehicleIdentity(fields: ParkingQueryRow['fields']): string | null {
  const raw = fieldValue(fields, fieldAliases.identity);
  if (!raw) return null;
  if (raw.includes('亲情')) return '亲情车';
  if (raw.includes('租')) return '租户车';
  if (raw.includes('业主') || raw.includes('住户')) return '住户车';
  return `旧库车辆类型 ${raw}`;
}

/** 256 位字符串中字符所在的位置就是旧停车系统的通道号，不是车位或库位。 */
function enabledChannelNumbers(value: string | null): number[] {
  if (!value) return [];
  return Array.from(value).flatMap((bit, index) => bit === '1' ? [index + 1] : []);
}

function garageRows(database: string, fields: ParkingQueryRow['fields']) {
  const effective = enabledChannelNumbers(fieldValue(fields, fieldAliases.effective));
  const downloaded = enabledChannelNumbers(fieldValue(fields, fieldAliases.download));
  const state = (channels: number[]) => ({
    authorized: database.toLowerCase() === (channels[0] === 5 ? 'parking1' : 'parking2') && channels.some((item) => effective.includes(item)),
    downloaded: database.toLowerCase() === (channels[0] === 5 ? 'parking1' : 'parking2') && channels.filter((item) => effective.includes(item)).every((item) => downloaded.includes(item)),
  });
  return [
    { key: 'phase1', label: '一期地面车库', source: 'parking1', ...state([5, 7]) },
    { key: 'phase2', label: '二期地面车库', source: 'parking2', ...state([9, 11, 13]) },
    { key: 'main', label: '二期大车库', source: 'parking2', ...state([15, 17, 19, 21]) },
    { key: 'civil', label: '二期人防车库', source: '德立云', authorized: false, downloaded: false, cloud: true },
  ];
}

function ParkingResultCard({ row, canWriteLocal, onCreateProof, onEditPms, proofLoading }: {
  row: ParkingQueryRow;
  canWriteLocal: boolean;
  onCreateProof: () => void;
  onEditPms: (owner: OwnerRow) => void;
  proofLoading: boolean;
}) {
  const plate = plateValue(row.fields);
  const owner = fieldValue(row.fields, fieldAliases.owner) || '未记录住户姓名';
  const room = fieldValue(row.fields, fieldAliases.room) || '未识别房号';
  const phone = fieldValue(row.fields, fieldAliases.phone);
  const space = fieldValue(row.fields, fieldAliases.space);
  const expiry = fieldValue(row.fields, fieldAliases.expiry);
  const identity = vehicleIdentity(row.fields);
  const note = fieldValue(row.fields, fieldAliases.note);
  const garages = garageRows(row.database, row.fields);
  const ownerId = fieldValue(row.fields, fieldAliases.ownerId);
  const details = Object.entries(row.fields).filter(([, value]) => value !== null && String(value).trim() !== '').slice(0, 24);
  return (
    <article className="parking-query-card">
      <div className={`parking-license-plate ${plate.length > 7 ? 'is-green' : 'is-blue'}`}><span>{plate}</span></div>
      <div className="parking-query-primary">
        <strong><HomeOutlined /> {room}</strong>
        <span><UserOutlined /> {owner}</span>
        <Tag color="blue">{row.database.toLowerCase() === 'parking1' ? '枫桦景苑一期旧库' : '枫桦景苑二期旧库'}</Tag>
      </div>
      <div className="parking-query-meta">
        {phone && <span><PhoneOutlined /> {phone}</span>}
        {space && <span><CarOutlined /> {space}</span>}
        {expiry && <span><CalendarOutlined /> 到期：{expiry}</span>}
      </div>
      <div className="parking-vehicle-type"><span>车辆授权类型</span><strong>{identity || '旧库未设置'}</strong><small>该类型决定续期价格，不代表车库权限</small></div>
      <div className="parking-garage-table" role="table" aria-label="车库授权和设备下载状态">
        <div className="parking-garage-head" role="row"><span>授权</span><span>车库</span><span>数据源</span><span>设备状态</span></div>
        {garages.map((garage) => <div className="parking-garage-row" role="row" key={garage.key}>
          <Checkbox checked={garage.authorized} disabled aria-label={`${garage.label}授权`} />
          <strong>{garage.label}</strong><span>{garage.source}</span>
          <Tag color={garage.cloud ? 'gold' : garage.authorized && garage.downloaded ? 'success' : garage.authorized ? 'warning' : 'default'}>
            {garage.cloud ? '以德立云车牌为准' : garage.authorized ? (garage.downloaded ? '已下载生效' : '待下载') : '未授权'}
          </Tag>
        </div>)}
      </div>
      <div className="parking-owner-compare">
        <OwnerDataPanel title={`旧停车系统${ownerId ? ` · 住户 #${ownerId}` : ''}`} name={owner} phone={phone} room={room} note={note}
          editable={false} editHint={canWriteLocal ? '旧库住户更新任务待对接' : '本地写入权限未通过'} />
        <OwnerDataPanel title="PMS 用户系统" name={row.pmsMatch?.name || '未关联'} phone={row.pmsMatch?.phone || null}
          room={row.pmsMatch?.house ? `${row.pmsMatch.house.communityName || ''} ${row.pmsMatch.house.lane || ''}弄 ${row.pmsMatch.house.buildingNo}号 ${row.pmsMatch.house.roomNo}室` : null}
          note={row.pmsMatch?.contactNote || null} editable={!!row.pmsMatch}
          onEdit={row.pmsMatch ? () => onEditPms({ id: row.pmsMatch!.userId, name: row.pmsMatch!.name, phone: row.pmsMatch!.phone, status: 'active', source: null, contactNote: row.pmsMatch!.contactNote, houseId: row.pmsMatch!.houseId, house: row.pmsMatch!.house }) : undefined} />
      </div>
      {identity === '亲情车' && (
        <div className="parking-family-actions">
          <div><strong>亲情车办理</strong><span>办公室不收费；门岗按优惠临时车计费。新增时必须收取证明材料。</span></div>
          <Button icon={<QrcodeOutlined />} loading={proofLoading} onClick={onCreateProof}>生成材料上传二维码</Button>
        </div>
      )}
      <details className="parking-query-details">
        <summary>查看旧库原始字段</summary>
        <dl>{details.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
      </details>
    </article>
  );
}

function OwnerDataPanel({ title, name, phone, room, note, editable, editHint, onEdit }: {
  title: string; name: string; phone: string | null; room: string | null; note: string | null;
  editable: boolean; editHint?: string; onEdit?: () => void;
}) {
  const text = [`姓名：${name}`, `电话：${phone || '未记录'}`, `房号：${room || '未记录'}`, `备注：${note || '无'}`].join('\n');
  return <section className="parking-owner-panel">
    <header><strong>{title}</strong><Space size={4}>
      <Button size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(text)}>复制</Button>
      <Button size="small" icon={<EditOutlined />} disabled={!editable} title={editHint} onClick={onEdit}>编辑</Button>
    </Space></header>
    <dl><div><dt>姓名</dt><dd>{name}</dd></div><div><dt>电话</dt><dd>{phone || '未记录'}</dd></div><div><dt>房号</dt><dd>{room || '未记录'}</dd></div><div><dt>备注</dt><dd>{note || '无'}</dd></div></dl>
    {!editable && editHint && <small>{editHint}</small>}
  </section>;
}
