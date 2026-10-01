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
  DownOutlined,
  EditOutlined,
  HomeOutlined,
  HistoryOutlined,
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
import ParkingLegacyOwnerModal, { type ParkingLegacyOwnerTarget } from './ParkingLegacyOwnerModal';
import './ParkingManagementPage.css';

const { Text, Title } = Typography;
type ParkingQueryRow = accessCardIssuance.ParkingQueryRow;
type ParkingHistoryResponse = accessCardIssuance.ParkingHistoryResponse;

export default function ParkingManagementPage({
  readinessOverride,
  rowsOverride,
  historyOverride,
}: {
  readinessOverride?: AccessCardReadiness;
  rowsOverride?: ParkingQueryRow[];
  historyOverride?: ParkingHistoryResponse;
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
  const [editingLegacyOwner, setEditingLegacyOwner] = useState<ParkingLegacyOwnerTarget | undefined>();
  const [legacyOwnerSaving, setLegacyOwnerSaving] = useState(false);
  const [legacyOwnerError, setLegacyOwnerError] = useState<string | null>(null);
  const [historyOwnerRow, setHistoryOwnerRow] = useState<ParkingQueryRow | null>(null);
  const [historyVehicleRow, setHistoryVehicleRow] = useState<ParkingQueryRow | null>(null);
  const [history, setHistory] = useState<ParkingHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

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
  const canWriteLocal = online && gateway?.capabilities?.parkingDbWrite === true && supportsParkingOwnerUpdates(gateway?.version);
  const deliyun = readiness?.deliyun;

  const searchParking = async (requestedTerm?: string) => {
    const queryTerm = (requestedTerm ?? term).trim();
    if (queryTerm.length < 2) {
      message.error('请输入至少 2 个字符，可输入房号、住户或车牌');
      return;
    }
    setSearching(true);
    setRows([]);
    setHistoryOwnerRow(null);
    setHistoryVehicleRow(null);
    setHistory(null);
    setSearchedTerm(queryTerm);
    try {
      if (rowsOverride) {
        setRows(rowsOverride);
        setHistoryOwnerRow(rowsOverride[0] ?? null);
        return;
      }
      let query = await accessCardIssuance.createParkingQuery(queryTerm);
      for (let attempt = 0; attempt < 90 && (query.status === 'pending' || query.status === 'running'); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        query = await accessCardIssuance.parkingQuery(query.id);
      }
      if (query.status === 'completed') {
        setRows(query.rows);
        setHistoryOwnerRow(query.rows[0] ?? null);
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

  const saveLegacyOwner = async (values: accessCardIssuance.ParkingOwnerValues) => {
    if (!editingLegacyOwner) return;
    setLegacyOwnerSaving(true);
    setLegacyOwnerError(null);
    try {
      let task = await accessCardIssuance.createParkingOwnerUpdate({
        database: editingLegacyOwner.database,
        externalOwnerId: editingLegacyOwner.externalOwnerId,
        pmsUserId: editingLegacyOwner.pmsUserId,
        idempotencyKey: createIdempotencyKey(),
        expected: editingLegacyOwner.values,
        values: normalizeOwnerValues(values),
        fieldHints: editingLegacyOwner.fieldHints,
      });
      for (let attempt = 0; attempt < 112 && (task.status === 'pending' || task.status === 'running'); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        task = await accessCardIssuance.parkingOwnerUpdate(task.id);
      }
      if (task.status === 'completed') {
        setEditingLegacyOwner(undefined);
        message.success('旧停车系统住户资料已更新并读回验证');
        await searchParking(searchedTerm || term);
        return;
      }
      if (task.status === 'failed') throw new Error(task.error || '旧停车系统拒绝了本次更新');
      throw new Error('现场数据同步助手响应超时，本次任务仍保留，请稍后重新查询状态');
    } catch (error) {
      const text = error instanceof Error ? error.message : '旧停车系统住户资料更新失败';
      setLegacyOwnerError(text);
      message.error(text);
    } finally {
      setLegacyOwnerSaving(false);
    }
  };

  const loadHistory = useCallback(async () => {
    if (!historyOwnerRow) return;
    const ownerRef = parkingHistoryRef(historyOwnerRow);
    const vehicleRef = historyVehicleRow ? parkingHistoryRef(historyVehicleRow) : null;
    if (!ownerRef.pmsUserId && !ownerRef.externalOwnerId && !vehicleRef?.sourceRecordId && !vehicleRef?.plate) {
      setHistory({ userHistory: [], vehicleHistory: [] });
      setHistoryError(null);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setHistory(historyOverride ?? await accessCardIssuance.parkingHistory({
        pmsUserId: ownerRef.pmsUserId,
        database: ownerRef.database,
        externalOwnerId: ownerRef.externalOwnerId,
        sourceRecordId: vehicleRef?.sourceRecordId,
        plate: vehicleRef?.plate,
      }));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '历史记录加载失败');
    } finally {
      setHistoryLoading(false);
    }
  }, [historyOwnerRow, historyVehicleRow, historyOverride]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

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
          ? `查询会实时读取现场一期、二期 Car_Issue 表。${canJoinOwners ? '住户表联查已启用。' : `当前助手 ${gateway?.version || '未知版本'} 可查车辆，升级 0.4.1 后还能按住户姓名、电话和房号联查。`}${canWriteLocal ? '旧库住户资料可直接编辑，保存后由现场助手写入并读回验证。' : '旧库住户资料写入需要将现场助手升级到 2.3.0 并确认数据库账号具备写权限。'}`
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
            <Tag color={canWriteLocal ? 'success' : 'gold'}>{canWriteLocal ? '住户资料可编辑' : '住户写入未就绪'}</Tag>
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
            {historyOwnerRow && (
              <ParkingHistoryCard
                rows={rows}
                ownerRow={historyOwnerRow}
                vehicleRow={historyVehicleRow}
                history={history}
                loading={historyLoading}
                error={historyError}
                onRetry={() => void loadHistory()}
                onSelectOwner={(row) => { setHistoryOwnerRow(row); setHistoryVehicleRow(null); }}
                onSelectVehicle={setHistoryVehicleRow}
              />
            )}
            {rows.map((row, index) => <ParkingResultCard
              key={`${row.database}-${index}`}
              row={row}
              canWriteLocal={canWriteLocal}
              proofLoading={proofLoading}
              onCreateProof={() => void createProofUpload(row)}
              onEditPms={(owner) => setEditingPmsOwner(owner)}
              onEditLegacy={(target) => { setLegacyOwnerError(null); setEditingLegacyOwner(target); }}
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
            <label>一次性连接密钥</label><pre>{credential.token}</pre>
            <Text type="secondary">在停车电脑双击数据同步助手，只需粘贴上方连接密钥。代理 ID 已包含在密钥中，无需另行输入。</Text>
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
      <ParkingLegacyOwnerModal
        target={editingLegacyOwner}
        saving={legacyOwnerSaving}
        error={legacyOwnerError}
        onClose={() => { if (!legacyOwnerSaving) setEditingLegacyOwner(undefined); }}
        onSubmit={saveLegacyOwner}
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

function supportsParkingOwnerUpdates(version?: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 2 ? (major > 2 || minor >= 3) : (major === 0 && minor >= 7);
}

function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `parking-owner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeOwnerValues(values: accessCardIssuance.ParkingOwnerValues): accessCardIssuance.ParkingOwnerValues {
  const clean = (value: string | null | undefined) => value?.trim() || null;
  return { name: clean(values.name), phone: clean(values.phone), room: clean(values.room), note: clean(values.note) };
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

function ownerFieldEntry(fields: ParkingQueryRow['fields'], aliases: readonly string[]): [string, string] | null {
  const entries = Object.entries(fields)
    .filter(([key, value]) => key.startsWith('Owner__') && value !== null && String(value).trim() !== '')
    .map(([key, value]) => [key.slice('Owner__'.length), String(value).trim()] as [string, string]);
  for (const alias of aliases) {
    const exact = entries.find(([key]) => normalizeFieldName(key) === alias);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const partial = entries.find(([key]) => normalizeFieldName(key).includes(alias));
    if (partial) return partial;
  }
  return null;
}

function ownerFieldValue(fields: ParkingQueryRow['fields'], aliases: readonly string[]): string | null {
  const joinedOwnerFields = Object.keys(fields).some((key) => key.startsWith('Owner__'));
  return ownerFieldEntry(fields, aliases)?.[1] ?? (joinedOwnerFields ? null : fieldValue(fields, aliases));
}

function ownerFieldHint(fields: ParkingQueryRow['fields'], aliases: readonly string[]): string | null {
  return ownerFieldEntry(fields, aliases)?.[0] ?? null;
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

function parkingExactFieldValue(fields: ParkingQueryRow['fields'], aliases: readonly string[]): string | null {
  const normalized = new Set(aliases.map(normalizeFieldName));
  const match = Object.entries(fields).find(([key, value]) =>
    value !== null && String(value).trim() !== '' && normalized.has(normalizeFieldName(key)));
  return match ? String(match[1]).trim() : null;
}

function parkingHistoryRef(row: ParkingQueryRow) {
  return row.historyRef ?? {
    database: row.database,
    sourceRecordId: parkingExactFieldValue(row.fields, ['p_id', 'pid', 'car_id', 'carid', 'issue_id', 'issueid']),
    externalOwnerId: parkingExactFieldValue(row.fields, fieldAliases.ownerId),
    plate: plateValue(row.fields) === '车牌字段待识别' ? null : plateValue(row.fields),
    pmsUserId: row.pmsMatch?.userId ?? null,
  };
}

function parkingOwnerKey(row: ParkingQueryRow): string {
  const ref = parkingHistoryRef(row);
  return ref.pmsUserId ? `pms:${ref.pmsUserId}` : `${ref.database}:external:${ref.externalOwnerId || 'unknown'}`;
}

function ParkingHistoryCard({ rows, ownerRow, vehicleRow, history, loading, error, onRetry, onSelectOwner, onSelectVehicle }: {
  rows: ParkingQueryRow[];
  ownerRow: ParkingQueryRow;
  vehicleRow: ParkingQueryRow | null;
  history: ParkingHistoryResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelectOwner: (row: ParkingQueryRow) => void;
  onSelectVehicle: (row: ParkingQueryRow | null) => void;
}) {
  const ownerKey = parkingOwnerKey(ownerRow);
  const ownerRows = Array.from(new Map(rows.map((row) => [parkingOwnerKey(row), row])).values());
  const ownerVehicles = rows.filter((row) => parkingOwnerKey(row) === ownerKey);
  const ownerName = ownerRow.pmsMatch?.name || fieldValue(ownerRow.fields, fieldAliases.owner) || '未记录姓名';
  return (
    <section className="parking-history-card" aria-labelledby="parking-history-title">
      <details className="parking-history-disclosure">
        <summary className="parking-history-summary">
          <div>
            <span className="parking-section-kicker">历史记录</span>
            <Title id="parking-history-title" level={4}><HistoryOutlined /> {ownerName}的变更历史</Title>
            <Text type="secondary">默认收起，展开后可查看用户、换牌和车牌绑定变更。</Text>
          </div>
          <span className="parking-history-toggle" aria-hidden="true">
            <span className="parking-history-toggle-collapsed">展开历史</span>
            <span className="parking-history-toggle-expanded">收起历史</span>
            <DownOutlined />
          </span>
        </summary>

        <div className="parking-history-body">
          <Text type="secondary">记录从本功能启用后开始保留；首次查询只建立基线，不会伪造为一次修改。</Text>
          {ownerRows.length > 1 && (
          <div className="parking-history-owner-switch" aria-label="切换要查看历史的用户">
            {ownerRows.map((row) => {
              const key = parkingOwnerKey(row);
              const name = row.pmsMatch?.name || fieldValue(row.fields, fieldAliases.owner) || '未记录姓名';
              return <Button key={key} type={key === ownerKey ? 'primary' : 'default'} onClick={() => onSelectOwner(row)}>{name}</Button>;
            })}
          </div>
          )}

          <div className="parking-history-vehicle-switch" aria-label="选择车牌历史">
            <Button type={vehicleRow ? 'default' : 'primary'} onClick={() => onSelectVehicle(null)}>只看用户历史</Button>
            {ownerVehicles.map((row) => {
              const ref = parkingHistoryRef(row);
              const selected = !!vehicleRow && parkingHistoryRef(vehicleRow).sourceRecordId === ref.sourceRecordId && vehicleRow.database === row.database;
              return (
                <Button key={`${row.database}-${ref.sourceRecordId || ref.plate}`} type={selected ? 'primary' : 'default'} onClick={() => onSelectVehicle(row)}>
                  <CarOutlined /> {ref.plate || '未识别车牌'}
                </Button>
              );
            })}
          </div>

          {loading ? <div className="parking-history-loading"><Spin /><span>正在读取历史记录…</span></div>
            : error ? <Alert type="error" showIcon message="历史记录加载失败" description={error} action={<Button onClick={onRetry}>重试</Button>} />
              : <div className={`parking-history-columns${vehicleRow ? ' has-vehicle' : ''}`}>
                <HistoryEntryList title="用户历史" entries={history?.userHistory ?? []} empty="这个用户还没有换牌、转绑或资料修改记录" />
                {vehicleRow && <HistoryEntryList title={`${parkingHistoryRef(vehicleRow).plate || '所选车牌'}历史`} entries={history?.vehicleHistory ?? []} empty="这个车牌还没有换牌、转绑或绑定资料修改记录" />}
              </div>}
        </div>
      </details>
    </section>
  );
}

function HistoryEntryList({ title, entries, empty }: {
  title: string;
  entries: accessCardIssuance.ParkingHistoryEntry[];
  empty: string;
}) {
  return <section className="parking-history-list">
    <h5>{title}<span>{entries.length} 条</span></h5>
    {entries.length ? <ol>{entries.map((entry) => <li key={entry.id}>
      <div className="parking-history-event-head">
        <Tag color={entry.eventType === 'plate_change' ? 'blue' : entry.eventType === 'owner_rebind' ? 'gold' : 'default'}>
          {entry.eventType === 'plate_change' ? '换牌' : entry.eventType === 'owner_rebind' ? '变更绑定用户' : '修改用户资料'}
        </Tag>
        <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString('zh-CN', { hour12: false })}</time>
      </div>
      <strong>{entry.summary}</strong>
      <dl>{entry.changes.map((change) => <div key={`${entry.id}-${change.field}`}>
        <dt>{change.label}</dt><dd><span>{change.before || '未记录'}</span><b aria-hidden="true">→</b><span>{change.after || '未记录'}</span></dd>
      </div>)}</dl>
      <small>{entry.operator} · {entry.source === 'pms' ? 'PMS' : entry.database || '旧停车库'}</small>
    </li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />}
  </section>;
}

function ParkingResultCard({ row, canWriteLocal, onCreateProof, onEditPms, onEditLegacy, proofLoading }: {
  row: ParkingQueryRow;
  canWriteLocal: boolean;
  onCreateProof: () => void;
  onEditPms: (owner: OwnerRow) => void;
  onEditLegacy: (target: ParkingLegacyOwnerTarget) => void;
  proofLoading: boolean;
}) {
  const plate = plateValue(row.fields);
  const ownerValue = ownerFieldValue(row.fields, fieldAliases.owner);
  const roomValue = ownerFieldValue(row.fields, fieldAliases.room);
  const phone = ownerFieldValue(row.fields, fieldAliases.phone);
  const owner = ownerValue || '未记录住户姓名';
  const room = roomValue || '未识别房号';
  const space = fieldValue(row.fields, fieldAliases.space);
  const expiry = fieldValue(row.fields, fieldAliases.expiry);
  const identity = vehicleIdentity(row.fields);
  const note = ownerFieldValue(row.fields, fieldAliases.note);
  const garages = garageRows(row.database, row.fields);
  const ownerId = row.historyRef?.externalOwnerId || ownerFieldValue(row.fields, fieldAliases.ownerId) || fieldValue(row.fields, fieldAliases.ownerId);
  const database = row.database.toLowerCase() === 'parking1' ? 'parking1' : 'parking2';
  const pmsRoom = row.pmsMatch?.house
    ? `${row.pmsMatch.house.lane || ''}/${row.pmsMatch.house.buildingNo}/${row.pmsMatch.house.roomNo}`.replace(/^\//, '')
    : null;
  const legacyTarget: ParkingLegacyOwnerTarget | null = ownerId ? {
    database,
    externalOwnerId: ownerId,
    pmsUserId: row.pmsMatch?.userId ?? null,
    plate,
    values: normalizeOwnerValues({ name: ownerValue, phone, room: roomValue, note }),
    pmsValues: row.pmsMatch ? normalizeOwnerValues({
      name: row.pmsMatch.name,
      phone: row.pmsMatch.phone,
      room: pmsRoom,
      note: row.pmsMatch.contactNote,
    }) : null,
    fieldHints: {
      name: ownerFieldHint(row.fields, fieldAliases.owner),
      phone: ownerFieldHint(row.fields, fieldAliases.phone),
      room: ownerFieldHint(row.fields, fieldAliases.room),
      note: ownerFieldHint(row.fields, fieldAliases.note),
    },
  } : null;
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
          editable={canWriteLocal && !!legacyTarget}
          editHint={!ownerId ? '旧停车系统没有返回住户编号，无法定位要更新的住户' : !canWriteLocal ? '请将现场数据同步助手升级到 2.3.0，并确认停车数据库账号具备写入权限' : undefined}
          onEdit={legacyTarget ? () => onEditLegacy(legacyTarget) : undefined} />
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
