import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Divider,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Select,
  Radio,
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
  CloudUploadOutlined,
  SwapOutlined,
  UserSwitchOutlined,
  StopOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  UserOutlined,
  InfoCircleOutlined,
  SyncOutlined,
  DollarOutlined,
} from '@ant-design/icons';
import {
  accessCardIssuance,
  type AccessCardReadiness,
} from '@pms/api-client';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import CopyableSecret from '../components/CopyableSecret';
import OwnerFormModal, { type OwnerRow } from './OwnerFormModal';
import ParkingLegacyOwnerModal, { type ParkingLegacyOwnerTarget } from './ParkingLegacyOwnerModal';
import './ParkingManagementPage.css';

const { Text, Title } = Typography;
type ParkingQueryRow = accessCardIssuance.ParkingQueryRow;
type ParkingHistoryResponse = accessCardIssuance.ParkingHistoryResponse;
type ParkingPlateCheckResult = {
  queryId: number | null;
  matches: ParkingQueryRow[];
};

async function executeParkingQuery(term: string): Promise<accessCardIssuance.ParkingQuery> {
  let query = await accessCardIssuance.createParkingQuery(term);
  for (let attempt = 0; attempt < 90 && (query.status === 'pending' || query.status === 'running'); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    query = await accessCardIssuance.parkingQuery(query.id);
  }
  if (query.status === 'completed') return query;
  if (query.status === 'failed') throw new Error(query.error || '停车数据库查询失败');
  throw new Error('停车网关响应超时，请确认现场电脑仍在线后重试');
}

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
  const [operationTarget, setOperationTarget] = useState<{ kind: accessCardIssuance.ParkingOperationKind; row: ParkingQueryRow | null } | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [lastOperation, setLastOperation] = useState<accessCardIssuance.ParkingOperation | null>(null);

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
  // 2.4.0 / 0.8.0 才按房号、车牌、电话和姓名选择字段并限制边界；旧版宽泛 LIKE 查询不再放行。
  const canQuery = canRead && supportsStructuredParkingQueries(gateway?.version);
  const canJoinOwners = canQuery;
  const canWriteLocal = online && gateway?.capabilities?.parkingDbWrite === true && supportsParkingOwnerUpdates(gateway?.version);
  const deliyun = readiness?.deliyun;

  const searchParking = async (requestedTerm?: string) => {
    const queryTerm = (requestedTerm ?? term).trim();
    const searchError = parkingSearchError(queryTerm);
    if (searchError) {
      message.error(searchError);
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
      const query = await executeParkingQuery(queryTerm);
      setRows(query.rows);
      setHistoryOwnerRow(query.rows[0] ?? null);
      if (query.rows.length === 0) message.info(`没有查到与“${queryTerm}”匹配的停车记录`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停车数据查询失败');
    } finally {
      setSearching(false);
    }
  };

  const queryExistingPlate = (plate: string) => {
    setOperationTarget(null);
    setOperationError(null);
    setTerm(plate);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    void searchParking(plate);
  };

  const checkParkingPlate = useCallback(async (plate: string): Promise<ParkingPlateCheckResult> => {
    const normalizedPlate = plate.replace(/[\s·]/g, '').toUpperCase();
    if (rowsOverride) {
      return {
        queryId: null,
        matches: rowsOverride.filter((row) => plateValue(row.fields).replace(/[\s·]/g, '').toUpperCase() === normalizedPlate),
      };
    }
    const query = await executeParkingQuery(normalizedPlate);
    return {
      queryId: query.id,
      matches: query.rows.filter((row) => plateValue(row.fields).replace(/[\s·]/g, '').toUpperCase() === normalizedPlate),
    };
  }, [rowsOverride]);

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

  const createProofUploadForPlate = async (plate: string, ownerId?: string) => accessCardIssuance.createParkingProofUpload({ plate, ownerId });
  const viewProofForPlate = async (plate: string) => {
    setProofLoading(true);
    try {
      const upload = await accessCardIssuance.parkingProofByPlate(plate);
      if (!upload) { message.info('这个车牌还没有已提交的亲情车证明材料'); return; }
      setProofUpload(upload);
    } catch (error) { message.error(error instanceof Error ? error.message : '读取亲情车证明材料失败'); }
    finally { setProofLoading(false); }
  };

  const runParkingOperation = async (kind: accessCardIssuance.ParkingOperationKind, row: ParkingQueryRow | null, payload: Record<string, unknown>) => {
    setOperationBusy(true); setOperationError(null);
    try {
      let task = await accessCardIssuance.createParkingOperation({
        database: row ? (row.database.toLowerCase() === 'parking1' ? 'parking1' : 'parking2') : ((payload.database as 'parking1' | 'parking2') || 'parking2'),
        kind, sourceRecordId: row ? parkingHistoryRef(row).sourceRecordId : null,
        pmsUserId: row?.pmsMatch?.userId ?? (kind === 'add_vehicle' && Number.isFinite(Number(payload.pmsUserId)) ? Number(payload.pmsUserId) : null),
        idempotencyKey: createIdempotencyKey(), payload,
      });
      setLastOperation(task);
      for (let attempt = 0; attempt < 112 && (task.status === 'pending' || task.status === 'running'); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        task = await accessCardIssuance.parkingOperation(task.id);
        setLastOperation(task);
      }
      if (task.status === 'completed') {
        message.success(`${operationLabel(kind)}已执行，旧库已读回验证`);
        setOperationTarget(null);
        await searchParking(searchedTerm || term);
      } else if (task.status === 'failed') throw new Error(task.error || `${operationLabel(kind)}失败，可修正后重试`);
      else throw new Error('现场助手响应超时，任务仍保留，可稍后刷新状态');
    } catch (error) {
      const text = error instanceof Error ? error.message : `${operationLabel(kind)}失败`;
      setOperationError(text); message.error(text);
    } finally { setOperationBusy(false); }
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
          ? `查询会按输入类型实时读取现场一期、二期停车库，并限制房号、车牌尾号、电话和姓名的匹配范围。${canJoinOwners ? '住户表联查已启用。' : ''}${canWriteLocal ? '旧库住户资料可直接编辑，保存后由现场助手写入并读回验证。' : '旧库住户资料写入需要数据库账号具备写权限。'}`
          : canRead
            ? `现场助手 ${gateway?.version || '未知版本'} 仍使用旧的宽泛查询规则，请升级到 2.4.0 后再查询，避免少量输入扫描过多数据。`
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
            <Text type="secondary">房号可输入 6/502 或 228/6/502；也支持住户姓名、7 位以上电话、完整车牌或至少 4 位车牌尾号。</Text>
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
              onViewProof={() => void viewProofForPlate(plateValue(row.fields))}
              onEditPms={(owner) => setEditingPmsOwner(owner)}
              onEditLegacy={(target) => { setLegacyOwnerError(null); setEditingLegacyOwner(target); }}
              onOperation={(kind) => { setOperationError(null); setLastOperation(null); setOperationTarget({ kind, row }); }}
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
        {canWriteLocal && <Button className="parking-add-vehicle-button" type="primary" icon={<PlusOutlined />} onClick={() => { setOperationError(null); setLastOperation(null); setOperationTarget({ kind: 'add_vehicle', row: null }); }}>新增车牌</Button>}
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
            <CopyableSecret label="一次性连接密钥" value={credential.token} />
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

      <ParkingOperationModal
        open={!!operationTarget}
        kind={operationTarget?.kind ?? 'add_vehicle'}
        row={operationTarget?.row ?? null}
        roomOptions={rows}
        loading={operationBusy}
        error={operationError}
        task={lastOperation}
        onClose={() => { if (!operationBusy) setOperationTarget(null); }}
        onRetry={() => { if (lastOperation) void runParkingOperation(operationTarget?.kind ?? 'add_vehicle', operationTarget?.row ?? null, lastOperation.payload); }}
        onRollback={async () => { if (!lastOperation) return; try { await accessCardIssuance.rollbackParkingOperation(lastOperation.id); message.success('已创建反向回滚任务'); } catch (error) { message.error(error instanceof Error ? error.message : '回滚任务创建失败'); } }}
        onCreateProofUpload={createProofUploadForPlate}
        onCheckPlate={checkParkingPlate}
        onQueryPlate={queryExistingPlate}
        onSubmit={(payload) => operationTarget && void runParkingOperation(operationTarget.kind, operationTarget.row, payload)}
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
              <><Alert type="success" showIcon message="证明材料已上传" description={proofUpload.fileName || '手机端已经提交，办公室可以继续办理亲情车。'} />{proofUpload.fileUrl && <a href={proofUpload.fileUrl} target="_blank" rel="noreferrer">查看已上传资料</a>}</>
            ) : (
              <Alert type={proofUpload.status === 'opened' ? 'info' : 'warning'} showIcon message={proofUpload.status === 'opened' ? '用户已打开上传页面' : '等待用户扫码'} description="二维码 1 小时有效，只能为当前车牌提交一次图片或 PDF。" />
            )}
            {proofUpload.qrDataUrl && <img src={proofUpload.qrDataUrl} alt="亲情车证明材料临时上传二维码" />}
            <Text type="secondary">{new Date(proofUpload.expiresAt).toLocaleString('zh-CN', { hour12: false })} 前有效</Text>
          </div>
        )}
      </Modal>
    </div>
  );
}

function supportsStructuredParkingQueries(version?: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 2) return true;
  if (major === 2) return minor >= 4;
  return major === 0 && minor >= 8;
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

function vehicleIdentityColor(identity: string | null): string {
  return ({
    住户车: 'blue',
    租户车: 'orange',
    亲情车: 'purple',
    小区服务车: 'cyan',
    小区工作车: 'green',
  } as Record<string, string>)[identity || ''] || 'default';
}

function ownerUpdateSource(source: string | null | undefined, updatedByName: string | null | undefined): string {
  if (updatedByName) return `PMS系统 · ${updatedByName}`;
  return ({
    manual: 'PMS后台建档',
    self: '业主自行认证',
    repair_intake: '报修登记',
    legacy_import: '旧系统导入',
  } as Record<string, string>)[source || ''] || 'PMS系统存量数据';
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
    { key: 'phase1', label: '一期地面车库', source: '来源：枫桦景苑一期停车系统', ...state([5, 7]) },
    { key: 'phase2', label: '二期地面车库', source: '来源：枫桦景苑二期停车系统', ...state([9, 11, 13]) },
    { key: 'main', label: '二期大车库', source: '来源：枫桦景苑二期停车系统', ...state([15, 17, 19, 21]) },
    { key: 'civil', label: '二期人防车库', source: '来源：德立云停车系统', authorized: false, downloaded: false, cloud: true },
  ];
}

function parkingExactFieldValue(fields: ParkingQueryRow['fields'], aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const normalizedAlias = normalizeFieldName(alias);
    const match = Object.entries(fields).find(([key, value]) =>
      value !== null && String(value).trim() !== '' && normalizeFieldName(key) === normalizedAlias);
    if (match) return String(match[1]).trim();
  }
  return null;
}

function normalizeParkingSourceRecordId(value: string | null): string | null {
  const result = value?.trim() || '';
  return result && !/^0+$/.test(result) ? result : null;
}

function parkingHistoryRef(row: ParkingQueryRow) {
  return row.historyRef ?? {
    database: row.database,
    sourceRecordId: normalizeParkingSourceRecordId(parkingExactFieldValue(row.fields, ['p_id', 'pid', 'issue_id', 'issueid', 'car_id', 'carid'])),
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
  const orderedEntries = [...entries].sort((left, right) => {
    const time = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
    return time || right.id - left.id;
  });
  return <section className="parking-history-list">
    <h5>{title}<span>{orderedEntries.length} 条 · 最新在前</span></h5>
    {orderedEntries.length ? <ol>{orderedEntries.map((entry) => <li key={entry.id}>
      <div className="parking-history-event-head">
        <Tag color={entry.eventType === 'plate_change' ? 'blue' : entry.eventType === 'owner_rebind' ? 'gold' : entry.eventType === 'vehicle_deleted' ? 'red' : entry.eventType === 'vehicle_renewed' ? 'green' : 'default'}>
          {entry.eventType === 'plate_change' ? '换牌' : entry.eventType === 'owner_rebind' ? '变更绑定用户' : entry.eventType === 'owner_info_update' ? '修改用户资料' : entry.eventType === 'vehicle_added' ? '新增车牌' : entry.eventType === 'vehicle_renewed' ? '续期收费' : entry.eventType === 'garage_authorization' ? '车库授权' : entry.eventType === 'vehicle_download' ? '设备下发' : '注销车辆'}
        </Tag>
        {entry.timeBasis === 'operation' || entry.source === 'pms'
          ? <time dateTime={entry.occurredAt}>操作时间：{new Date(entry.occurredAt).toLocaleString('zh-CN', { hour12: false })}</time>
          : <span className="parking-history-time-pending">操作时间待旧库回传</span>}
      </div>
      <strong>{entry.summary}</strong>
      <dl>{entry.changes.map((change) => <div key={`${entry.id}-${change.field}`}>
        <dt>{change.label}</dt><dd><span>{change.before || '未记录'}</span><b aria-hidden="true">→</b><span>{change.after || '未记录'}</span></dd>
      </div>)}</dl>
      <small>{entry.operator} · {entry.source === 'pms' ? 'PMS' : entry.database || '旧停车库'}</small>
    </li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />}
  </section>;
}

function ParkingResultCard({ row, canWriteLocal, onCreateProof, onViewProof, onEditPms, onEditLegacy, proofLoading, onOperation }: {
  row: ParkingQueryRow;
  canWriteLocal: boolean;
  onCreateProof: () => void;
  onViewProof: () => void;
  onEditPms: (owner: OwnerRow) => void;
  onEditLegacy: (target: ParkingLegacyOwnerTarget) => void;
  proofLoading: boolean;
  onOperation: (kind: accessCardIssuance.ParkingOperationKind) => void;
}) {
  const plate = plateValue(row.fields);
  const rawOwnerValue = ownerFieldValue(row.fields, fieldAliases.owner);
  const roomInName = legacyRoomFromName(rawOwnerValue);
  const ownerValue = roomInName ? null : rawOwnerValue;
  const roomValue = ownerFieldValue(row.fields, fieldAliases.room) || roomInName;
  const phone = ownerFieldValue(row.fields, fieldAliases.phone);
  const owner = ownerValue || '未记录住户姓名';
  const room = roomValue || '未识别房号';
  const space = fieldValue(row.fields, fieldAliases.space);
  const expiry = fieldValue(row.fields, fieldAliases.expiry);
  const expiryView = parkingExpiryView(expiry);
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
  return (
    <article className="parking-query-card">
      <div className={`parking-license-plate ${plate.length > 7 ? 'is-green' : 'is-blue'}`}><span>{plate}</span></div>
      <div className="parking-query-primary">
        <strong><HomeOutlined /> {room}</strong>
        <span className="parking-important-value"><UserOutlined /> {owner}</span>
        <Tag color="blue">{row.database.toLowerCase() === 'parking1' ? '来源：枫桦景苑一期停车系统' : '来源：枫桦景苑二期停车系统'}</Tag>
      </div>
      <div className="parking-query-meta">
        {phone && <span className="parking-important-value"><PhoneOutlined /> {phone}</span>}
        {space && <span><CarOutlined /> {space}</span>}
        {expiryView && <span className="parking-expiry-line"><CalendarOutlined /> 到期：{expiryView.date}
          {expiryView.days !== null && <b className={expiryView.days < 0 ? 'is-expired' : 'is-valid'}>有效期 {expiryView.days} 天</b>}
        </span>}
      </div>
      <div className="parking-vehicle-type">
        <span>车辆授权类型</span>
        <Tag className="parking-vehicle-type-tag" color={vehicleIdentityColor(identity)}>{identity || '旧库未设置'}</Tag>
        {identity === '亲情车' && (
          <div className="parking-family-actions">
            <div className="parking-family-action-copy"><strong>亲情车办理</strong><span>办公室不收费；门岗按优惠临时车计费。新增时必须收取证明材料。</span></div>
            <div className="parking-family-action-buttons">
              <Button icon={<QrcodeOutlined />} loading={proofLoading} onClick={onCreateProof}>生成材料上传二维码</Button>
              <Button icon={<SearchOutlined />} loading={proofLoading} onClick={onViewProof}>查看已上传资料</Button>
            </div>
          </div>
        )}
      </div>
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
        <OwnerDataPanel title="旧停车系统住户信息" name={owner} phone={phone} room={room} note={note}
          editable={canWriteLocal && !!legacyTarget}
          editHint={!ownerId ? '旧停车系统没有返回住户编号，无法定位要更新的住户' : !canWriteLocal ? '请确认现场数据同步助手为 2.4.0，并检查停车数据库账号的写入权限' : undefined}
          onEdit={legacyTarget ? () => onEditLegacy(legacyTarget) : undefined} />
        <OwnerDataPanel title="PMS系统业主信息" name={row.pmsMatch?.name || '未关联'} phone={row.pmsMatch?.phone || null}
          room={row.pmsMatch?.house ? `${row.pmsMatch.house.communityName || ''} ${row.pmsMatch.house.lane || ''}弄 ${row.pmsMatch.house.buildingNo}号 ${row.pmsMatch.house.roomNo}室` : null}
          note={row.pmsMatch?.contactNote || null} editable={!!row.pmsMatch}
          updatedAt={row.pmsMatch?.updatedAt || null}
          updateSource={row.pmsMatch ? ownerUpdateSource(row.pmsMatch.source, row.pmsMatch.updatedByName) : null}
          editHint={!row.pmsMatch ? '没有找到该房号或电话号码对应的 PMS 业主档案' : undefined}
          onEdit={row.pmsMatch ? () => onEditPms({ id: row.pmsMatch!.userId, name: row.pmsMatch!.name, phone: row.pmsMatch!.phone, status: row.pmsMatch!.status || 'active', source: row.pmsMatch!.source ?? null, contactNote: row.pmsMatch!.contactNote, houseId: row.pmsMatch!.houseId, house: row.pmsMatch!.house }) : undefined} />
      </div>
      <div className="parking-operation-actions" aria-label="停车业务操作">
        <Button type="primary" disabled={!canWriteLocal} icon={<CalendarOutlined />} onClick={() => onOperation('renew_vehicle')}>续期收费</Button>
        <Button disabled={!canWriteLocal} icon={<SwapOutlined />} onClick={() => onOperation('change_plate')}>变更车牌</Button>
        <Button disabled={!canWriteLocal} icon={<UserSwitchOutlined />} onClick={() => onOperation('rebind_owner')}>变更绑定用户</Button>
        <Button disabled={!canWriteLocal} icon={<SafetyCertificateOutlined />} onClick={() => onOperation('update_garages')}>调整车库授权</Button>
        <Button disabled={!canWriteLocal} icon={<CloudUploadOutlined />} onClick={() => onOperation('download_vehicle')}>下发设备</Button>
        <Button danger disabled={!canWriteLocal} icon={<StopOutlined />} onClick={() => onOperation('delete_vehicle')}>注销车辆</Button>
      </div>
    </article>
  );
}

function parkingRenewalEndDate(currentEndDate: string, months: number): string {
  const parsed = dayjs(currentEndDate);
  return parsed.isValid() ? parsed.add(months, 'month').format('YYYY-MM-DD') : '';
}

function ParkingOperationModal({ open, kind, row, roomOptions, loading, error, task, onClose, onSubmit, onRetry, onRollback, onCreateProofUpload, onCheckPlate, onQueryPlate }: {
  open: boolean;
  kind: accessCardIssuance.ParkingOperationKind;
  row: ParkingQueryRow | null;
  roomOptions: ParkingQueryRow[];
  onCreateProofUpload: (plate: string, ownerId?: string) => Promise<accessCardIssuance.ParkingProofUpload>;
  onCheckPlate: (plate: string) => Promise<ParkingPlateCheckResult>;
  onQueryPlate: (plate: string) => void;
  loading: boolean;
  error: string | null;
  task: accessCardIssuance.ParkingOperation | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onRetry: () => void;
  onRollback: () => void;
}) {
  const [plate, setPlate] = useState('');
  const [newPlate, setNewPlate] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [endDate, setEndDate] = useState('');
  const [previousEndDate, setPreviousEndDate] = useState('');
  const [identity, setIdentity] = useState('住户车');
  const [amount, setAmount] = useState<number | null>(null);
  const [months, setMonths] = useState(1);
  const [selectedGarages, setSelectedGarages] = useState<string[]>([]);
  const [effective, setEffective] = useState('');
  const [download, setDownload] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    const fields = row?.fields || {};
    const currentPlate = row ? plateValue(fields) : '';
    const currentEndDate = row ? (fieldValue(fields, fieldAliases.expiry) || '').slice(0, 10) : '';
    setPlate(currentPlate === '车牌字段待识别' ? '' : currentPlate);
    setNewPlate(''); setOwnerName(row ? ownerFieldValue(fields, fieldAliases.owner) || '' : '');
    setOwnerId(row ? parkingHistoryRef(row).externalOwnerId || '' : '');
    setEndDate(kind === 'renew_vehicle' ? parkingRenewalEndDate(currentEndDate, 1) : currentEndDate);
    setPreviousEndDate(currentEndDate);
    setIdentity(row ? vehicleIdentity(fields) || '住户车' : '住户车'); setAmount(null); setMonths(1);
    setEffective(row ? fieldValue(fields, fieldAliases.effective) || '' : '');
    setDownload(row ? fieldValue(fields, fieldAliases.download) || '' : '');
    setNote(row ? fieldValue(fields, fieldAliases.note) || '' : '');
    const garages = row ? garageRows(row.database, fields).filter((item) => item.authorized && !item.cloud).map((item) => item.key) : [];
    setSelectedGarages(garages);
  }, [open, row, kind]);
  const changeMonths = (value: number) => {
    setMonths(value);
    if (kind === 'renew_vehicle' && previousEndDate) {
      setEndDate(parkingRenewalEndDate(previousEndDate, value));
    }
  };
  const title = operationLabel(kind);
  const submit = () => {
    const monthly = identity === '租户车' ? 260 : identity === '亲情车' ? 0 : 180;
    const annual = identity === '租户车' ? 2760 : identity === '亲情车' ? 0 : 1800;
    const calculatedAmount = amount ?? (months >= 12 ? annual * Math.floor(months / 12) + monthly * (months % 12) : monthly * months);
    const payload: Record<string, unknown> = { plate, newPlate, ownerName, ownerId, endDate, previousEndDate, identity, amount: calculatedAmount, months, effective, download, note };
    if (kind === 'add_vehicle' || kind === 'update_garages') payload.effective = garageBitString(selectedGarages);
    onSubmit(payload);
  };
  if (kind === 'add_vehicle') return <AddVehicleOperationModal open={open} loading={loading} error={error} task={task} roomOptions={roomOptions} onClose={onClose} onSubmit={onSubmit} onRetry={onRetry} onRollback={onRollback} onCreateProofUpload={onCreateProofUpload} onCheckPlate={onCheckPlate} onQueryPlate={onQueryPlate} />;
  return <Modal title={title} open={open} onCancel={onClose} confirmLoading={loading} okText={kind === 'delete_vehicle' ? '确认注销' : '提交操作'} okButtonProps={{ danger: kind === 'delete_vehicle' }} onOk={submit}>
    {error && <Alert type="error" showIcon message="操作未完成" description={error} action={<Space><Button size="small" onClick={onRetry}>重试</Button>{task?.status === 'completed' && <Button size="small" danger onClick={onRollback}>创建回滚</Button>}</Space>} />}
    <div className="parking-operation-form">
      <label>车牌<Input value={plate} disabled={!row} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></label>
      {kind === 'change_plate' && <label>新车牌<Input value={newPlate} onChange={(e) => setNewPlate(e.target.value.toUpperCase())} /></label>}
      {(kind === 'change_plate' || kind === 'rebind_owner') && <label>绑定用户姓名<Input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></label>}
      {kind === 'renew_vehicle' && <><label>快捷期限<Select value={months} options={[1, 2, 3, 6, 12].map((value: number) => ({ value, label: `${value}个月` }))} onChange={changeMonths} /><InputNumber min={0} value={amount} onChange={setAmount} addonAfter="元" /><Text type="secondary">留空按收费规则验算：业主车月价 ¥180、12个月 ¥1800；租户车月价 ¥260、12个月 ¥2760。可在提交前覆盖本次金额。</Text></label><label>到期日期<DatePicker value={endDate ? dayjs(endDate) : null} format="YYYY-MM-DD" placeholder="选择到期日期" allowClear placement="bottomLeft" popupClassName="parking-date-picker-popup" onChange={(value) => setEndDate(value ? value.format('YYYY-MM-DD') : '')} style={{ width: '100%' }} />{kind === 'renew_vehicle' && <Text type="secondary">选择快捷期限会从当前到期日往后顺延。</Text>}</label></>}
      {kind === 'update_garages' && <label>车库授权<Checkbox.Group value={selectedGarages} onChange={(values) => setSelectedGarages(values as string[])} options={[{ label: '一期地面车库', value: 'phase1' }, { label: '二期地面车库', value: 'phase2' }, { label: '二期大车库', value: 'main' }]} /></label>}
      {(kind === 'change_plate' || kind === 'rebind_owner') && <label>车辆授权类型<Select value={identity} options={['住户车', '租户车', '亲情车', '小区服务车', '小区工作车'].map((value) => ({ value, label: value }))} onChange={setIdentity} /></label>}
      {kind === 'download_vehicle' && <Alert type="info" showIcon message="将创建旧库设备下载任务" description="任务完成只代表旧系统已接受并回读下载队列；现场控制器回执会在状态中单独显示。" />}
      {kind === 'delete_vehicle' && <Alert type="warning" showIcon message="注销会调用旧系统 Add_Del_Plate" description="车辆从旧库移除并写入注销流水，网页不会直接删除 Car_Issue。" />}
      {task?.status === 'completed' && <Button danger onClick={onRollback}>为本次操作创建反向回滚任务</Button>}
    </div>
  </Modal>;
}

type AddVehicleRoomOption = {
  key: string;
  database: 'parking1' | 'parking2';
  pmsUserId: number;
  roomKey: string;
  communityName: string;
  buildingNo: string;
  roomNo: string;
  name: string;
  phone: string;
};

function buildAddVehicleRoomOptions(rows: ParkingQueryRow[]): AddVehicleRoomOption[] {
  const seen = new Map<string, AddVehicleRoomOption>();
  rows.forEach((row) => {
    const match = row.pmsMatch;
    const house = match?.house;
    if (!match || !house) return;
    const database = row.database.toLowerCase() === 'parking1' ? 'parking1' : 'parking2';
    const roomKey = [house.lane, house.buildingNo, house.roomNo].filter(Boolean).join('/');
    const key = `${database}:${match.userId}:${house.id}`;
    if (!seen.has(key)) seen.set(key, {
      key,
      database,
      pmsUserId: match.userId,
      roomKey,
      communityName: house.communityName || (database === 'parking1' ? '枫桦景苑一期' : '枫桦景苑二期'),
      buildingNo: house.buildingNo,
      roomNo: house.roomNo,
      name: match.name || '未填写姓名',
      phone: match.phone || '未记录电话',
    });
  });
  return Array.from(seen.values());
}

const parkingPlateProvinces = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新'.split('');
const parkingPlateLetters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const parkingPlateAlphaNumeric = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'.split('');

function parkingDuplicateDescription(row: ParkingQueryRow): string {
  const database = row.database.toLowerCase() === 'parking1' ? '枫桦景苑一期停车系统' : '枫桦景苑二期停车系统';
  const rawOwner = ownerFieldValue(row.fields, fieldAliases.owner);
  const room = ownerFieldValue(row.fields, fieldAliases.room) || legacyRoomFromName(rawOwner) || '房号未记录';
  const owner = legacyRoomFromName(rawOwner) ? '姓名未记录' : rawOwner || '姓名未记录';
  return `${database} · ${room} · ${owner}`;
}

function AddVehicleOperationModal({ open, loading, error, task, roomOptions, onClose, onSubmit, onRetry, onRollback, onCreateProofUpload, onCheckPlate, onQueryPlate }: {
  open: boolean;
  loading: boolean;
  error: string | null;
  task: accessCardIssuance.ParkingOperation | null;
  roomOptions: ParkingQueryRow[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onRetry: () => void;
  onRollback: () => void;
  onCreateProofUpload: (plate: string, ownerId?: string) => Promise<accessCardIssuance.ParkingProofUpload>;
  onCheckPlate: (plate: string) => Promise<ParkingPlateCheckResult>;
  onQueryPlate: (plate: string) => void;
}) {
  const [plate, setPlate] = useState('');
  const [step, setStep] = useState<'plate' | 'details'>('plate');
  const [roomKey, setRoomKey] = useState('');
  const [identity, setIdentity] = useState('住户车');
  const [months, setMonths] = useState(1);
  const [garages, setGarages] = useState<string[]>([]);
  const [fieldPhone, setFieldPhone] = useState('');
  const [phoneOverride, setPhoneOverride] = useState(false);
  const [proofUpload, setProofUpload] = useState<accessCardIssuance.ParkingProofUpload | null>(null);
  const [proofApproved, setProofApproved] = useState(false);
  const [proofLoading, setProofLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedPlate, setCheckedPlate] = useState('');
  const [duplicateMatches, setDuplicateMatches] = useState<ParkingQueryRow[]>([]);
  const [duplicateCheckError, setDuplicateCheckError] = useState<string | null>(null);
  const [duplicateCheckNonce, setDuplicateCheckNonce] = useState(0);
  const [submittingCheck, setSubmittingCheck] = useState(false);
  const normalized = plate.replace(/[\s·]/g, '').toUpperCase().slice(0, 8);
  const isGreen = normalized.length === 8;
  const rooms = buildAddVehicleRoomOptions(roomOptions);
  const selectedRoom = rooms.find((item) => item.key === roomKey) || null;
  const monthly = identity === '租户车' ? 260 : identity === '亲情车' ? 0 : 180;
  const annual = identity === '租户车' ? 2760 : identity === '亲情车' ? 0 : 1800;
  const amount = identity === '亲情车' ? 0 : months === 12 ? annual : monthly * months;
  const isFamily = identity === '亲情车';
  const provinceSelected = parkingPlateProvinces.includes(normalized.slice(0, 1));
  const plateFormatValid = new RegExp(`^[${parkingPlateProvinces.join('')}][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}$`).test(normalized);
  const duplicateCheckPassed = plateFormatValid && checkedPlate === normalized && !checking && !duplicateCheckError && duplicateMatches.length === 0;
  const keyboardMode = !provinceSelected ? 'province' : normalized.length === 1 ? 'letter' : 'number';
  const keyboardKeys = keyboardMode === 'province' ? parkingPlateProvinces : keyboardMode === 'letter' ? parkingPlateLetters : parkingPlateAlphaNumeric;
  const keyboardTitle = keyboardMode === 'province' ? '第 1 步 · 选择省市简称' : keyboardMode === 'letter' ? '第 2 步 · 选择发牌机关字母' : '继续输入车牌序号';
  const keyboardHint = keyboardMode === 'province' ? '已补齐全国 31 个省、自治区、直辖市简称' : keyboardMode === 'letter' ? '第二位只能输入英文字母' : '可输入字母或数字，普通车牌共 7 位，新能源车牌共 8 位';

  useEffect(() => {
    if (!open) return;
    setStep('plate'); setPlate(''); setRoomKey(''); setIdentity('住户车'); setMonths(1); setGarages([]); setFieldPhone(''); setPhoneOverride(false); setProofUpload(null); setProofApproved(false); setValidationError(null); setChecking(false); setCheckedPlate(''); setDuplicateMatches([]); setDuplicateCheckError(null); setSubmittingCheck(false);
  }, [open]);

  useEffect(() => {
    if (!open || !rooms.length || roomKey) return;
    const first = rooms[0];
    setRoomKey(first.key);
    setGarages(first.roomKey.startsWith('198/') ? ['phase1'] : ['phase2']);
  }, [open, roomKey, rooms]);

  useEffect(() => {
    if (!open || !plateFormatValid) {
      setChecking(false);
      setCheckedPlate('');
      setDuplicateMatches([]);
      setDuplicateCheckError(null);
      return undefined;
    }
    let cancelled = false;
    setChecking(true);
    setCheckedPlate('');
    setDuplicateMatches([]);
    setDuplicateCheckError(null);
    const timer = window.setTimeout(() => {
      void onCheckPlate(normalized)
        .then((result) => {
          if (cancelled) return;
          setCheckedPlate(normalized);
          setDuplicateMatches(result.matches);
        })
        .catch((checkError) => {
          if (cancelled) return;
          setCheckedPlate(normalized);
          setDuplicateCheckError(checkError instanceof Error ? checkError.message : '停车旧库查重失败');
        })
        .finally(() => { if (!cancelled) setChecking(false); });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [duplicateCheckNonce, normalized, onCheckPlate, open, plateFormatValid]);

  useEffect(() => {
    if (!proofUpload || proofUpload.status === 'submitted') return undefined;
    const timer = window.setInterval(async () => {
      try {
        const next = await accessCardIssuance.parkingProofUpload(proofUpload.id);
        setProofUpload((current) => current?.id === next.id ? { ...current, ...next } : current);
      } catch { /* 二维码轮询短暂失败不影响当前登记窗口。 */ }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [proofUpload?.id, proofUpload?.status]);

  const appendPlate = (char: string) => setPlate((value) => `${value}${char}`.replace(/[\s·]/g, '').toUpperCase().slice(0, 8));
  const chooseRoom = (key: string) => {
    const next = rooms.find((item) => item.key === key);
    setRoomKey(key);
    setGarages(next?.roomKey.startsWith('198/') ? ['phase1'] : ['phase2']);
  };
  const createProof = async () => {
    if (normalized.length < 7) { setValidationError('请先输入完整车牌，再生成亲情车证明材料二维码'); return; }
    setProofLoading(true); setValidationError(null);
    try { setProofUpload(await onCreateProofUpload(normalized)); setProofApproved(false); }
    catch (createError) { setValidationError(createError instanceof Error ? createError.message : '亲情车二维码生成失败'); }
    finally { setProofLoading(false); }
  };
  const submit = async () => {
    if (!plateFormatValid) return setValidationError('车牌格式不正确：请先选择省市简称，第二位输入字母，再输入 5 至 6 位字母或数字');
    if (!selectedRoom) return setValidationError(rooms.length ? '请选择 PMS 房号' : '当前没有可选择的 PMS 房号，请先查询一个已关联 PMS 用户的房号');
    setSubmittingCheck(true);
    setValidationError(null);
    try {
      const freshCheck = await onCheckPlate(normalized);
      setCheckedPlate(normalized);
      setDuplicateMatches(freshCheck.matches);
      if (freshCheck.matches.length) {
        setStep('plate');
        return setValidationError(`车牌 ${normalized} 已在旧停车系统中登记，不能重复新增；请从查询结果办理续期、换牌或授权调整`);
      }
      const pendingFamilyReview = isFamily && (!proofUpload || proofUpload.status !== 'submitted' || !proofApproved);
      const note = phoneOverride && fieldPhone.trim() ? `${dayjs().format('YYYY-MM-DD HH:mm')} 停车登记电话；操作来源：PMS系统` : '操作来源：PMS系统';
      onSubmit({
        database: selectedRoom.database,
        pmsUserId: selectedRoom.pmsUserId,
        plate: normalized,
        ownerName: selectedRoom.name,
        ownerPhone: fieldPhone.trim() || selectedRoom.phone,
        ownerAddress: selectedRoom.roomKey,
        identity,
        amount: pendingFamilyReview ? 0 : amount,
        months,
        startDate: dayjs().format('YYYY-MM-DD'),
        endDate: dayjs().add(months, 'month').format('YYYY-MM-DD'),
        effective: pendingFamilyReview ? new Array(256).fill('0').join('') : garageBitString(garages.filter((value) => value !== 'civil')),
        state: pendingFamilyReview ? 0 : 1,
        requiresProofReview: pendingFamilyReview,
        duplicateCheckQueryId: freshCheck.queryId,
        note,
      });
    } catch (checkError) {
      setValidationError(`提交前查重失败：${checkError instanceof Error ? checkError.message : '请确认停车网关在线后重试'}`);
    } finally {
      setSubmittingCheck(false);
    }
  };
  return <Drawer className="parking-new-drawer" width={760} open={open} onClose={onClose} title="新增车牌" destroyOnClose={false} extra={<Tag color="blue">{step === 'plate' ? '1 / 2 车牌查重' : '2 / 2 登记资料'}</Tag>}>
    {error && <Alert type="error" showIcon message="新增车牌未完成" description={error} action={<Space><Button size="small" onClick={onRetry}>重试</Button>{task?.status === 'completed' && <Button size="small" danger onClick={onRollback}>创建回滚</Button>}</Space>} />}
    {validationError && <Alert type="warning" showIcon closable message={validationError} onClose={() => setValidationError(null)} />}
    <div className="parking-new-flow"><span className={step === 'plate' ? 'is-current' : 'is-done'}>1 <small>车牌查重</small></span><i /><span className={step === 'details' ? 'is-current' : ''}>2 <small>登记资料</small></span></div>
    {step === 'plate' ? <>
      <Alert type="info" showIcon message="输入完整车牌后自动查重" description="系统会真实查询枫桦景苑一期、二期停车旧库；任一旧库已存在该车牌都不能继续新增。" />
      <div className="parking-plate-entry parking-plate-entry-design">
        <label htmlFor="parking-add-plate-input">车牌号码</label>
        <Input id="parking-add-plate-input" size="large" value={normalized} onChange={(event) => setPlate(event.target.value.replace(/[\s·]/g, '').toUpperCase().slice(0, 8))} suffix={checking ? <SyncOutlined spin /> : duplicateCheckPassed ? <CheckCircleOutlined className="parking-plate-check-ok" /> : undefined} placeholder="请输入车牌，例如 沪EDK889" />
        <div className={`parking-license-plate is-${isGreen ? 'green' : 'blue'} is-large`}><span>{normalized ? `${normalized.slice(0, 1)} ${normalized.slice(1, 2)}·${normalized.slice(2)}` : '请选择省市简称'}</span></div>
        <Text type="secondary"><InfoCircleOutlined /> 可点击下方两步键盘，也可直接使用电脑键盘输入。</Text>
      </div>
      <div className={`parking-plate-keyboard is-${keyboardMode}`}>
        <div className="parking-keyboard-heading"><div><strong>{keyboardTitle}</strong><span>{keyboardHint}</span></div>{provinceSelected && <Button type="link" onClick={() => setPlate('')}>重选省市简称</Button>}</div>
        <div className="parking-key-grid">{keyboardKeys.map((key) => <button type="button" key={key} aria-label={`输入 ${key}`} onClick={() => appendPlate(key)}>{key}</button>)}</div>
        <div className="parking-key-actions"><Button disabled={!normalized} onClick={() => setPlate((value) => value.slice(0, -1))}>退格</Button><Button danger disabled={!normalized} onClick={() => setPlate('')}>清空</Button></div>
      </div>
      <div className="parking-duplicate-result" role="status" aria-live="polite">
        {checking ? <div className="parking-checking"><SyncOutlined spin /> 正在真实查询一期、二期停车旧库…</div>
          : duplicateMatches.length > 0 && checkedPlate === normalized ? <Alert type="error" showIcon message={`车牌 ${normalized} 已在旧停车系统中登记，不能新增`} action={<Button size="small" type="primary" icon={<SearchOutlined />} onClick={() => onQueryPlate(normalized)}>查询此车牌</Button>} description={<div className="parking-duplicate-matches">{duplicateMatches.map((row, index) => <span key={`${row.database}-${parkingHistoryRef(row).sourceRecordId || index}`}><StopOutlined /> {parkingDuplicateDescription(row)}</span>)}<b>点击“查询此车牌”后可直接办理续期、换牌或调整车库授权。</b></div>} />
            : duplicateCheckError && checkedPlate === normalized ? <Alert type="error" showIcon message="车牌查重失败，暂时不能继续" description={duplicateCheckError} action={<Button onClick={() => setDuplicateCheckNonce((value) => value + 1)}>重新查重</Button>} />
              : duplicateCheckPassed ? <Alert type="success" showIcon message="一期、二期旧库均未发现该车牌" description="进入登记资料后，正式提交前还会再次查询，避免重复新增。" />
                : normalized.length >= 7 && !plateFormatValid ? <Alert type="warning" showIcon message="车牌格式不正确" description="请先选择省市简称，第二位输入字母，再输入 5 至 6 位字母或数字；字母 I、O 不用于普通车牌。" />
                  : <Text type="secondary">请输入完整车牌，系统会自动开始真实查重。</Text>}
      </div>
      <div className="parking-new-drawer-actions"><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!duplicateCheckPassed} onClick={() => setStep('details')}>继续登记资料</Button></div>
    </> : <>
      <div className="parking-new-plate-summary"><div className={`parking-license-plate is-${isGreen ? 'green' : 'blue'}`}><span>{normalized.slice(0, 1)} {normalized.slice(1, 2)}·{normalized.slice(2)}</span></div><div><strong>新车登记</strong><Text type="secondary">一期、二期停车旧库均已完成真实查重。</Text></div></div>
      <Divider orientation="left">1 · PMS 房号与住户</Divider>
      <div className="parking-new-form-section"><label>PMS 房号<Select showSearch value={roomKey || undefined} disabled={!rooms.length} optionFilterProp="label" onChange={chooseRoom} placeholder={rooms.length ? '选择 PMS 房号' : '请先查询并关联 PMS 房号'} options={rooms.map((item) => ({ value: item.key, label: `${item.roomKey} · ${item.name}` }))} /></label>{selectedRoom ? <div className="parking-pms-resident-card"><span className="parking-pms-resident-icon"><HomeOutlined /></span><div><strong>{selectedRoom.roomKey}</strong><Text>{selectedRoom.communityName} · {selectedRoom.buildingNo}号楼 · {selectedRoom.roomNo}室</Text></div><div><small>姓名</small><strong>{selectedRoom.name}</strong></div><div><small>电话</small><strong>{selectedRoom.phone}</strong></div></div> : <Alert type="info" showIcon message="请选择已关联 PMS 用户的房号" description="新增车牌不会让操作员手工输入旧系统住户编号。" />}{!phoneOverride ? <Button type="link" icon={<PhoneOutlined />} onClick={() => setPhoneOverride(true)}>现场电话不一致？填写停车登记电话</Button> : <div className="parking-phone-override"><label>现场登记电话<Input value={fieldPhone} onChange={(event) => setFieldPhone(event.target.value)} placeholder="输入现场提供的新电话" /></label><Text type="secondary">将记录为“{dayjs().format('YYYY-MM-DD HH:mm')} 停车登记电话”；写入旧库时房号统一规范为 {selectedRoom?.roomKey || '198/6/501'}。</Text></div>}</div>
      <Divider orientation="left">2 · 车辆授权类型</Divider><div className="parking-new-form-section"><Text type="secondary">授权类型决定收费规则，默认按住户车计价。</Text><Radio.Group className="parking-horizontal-options" value={identity} onChange={(event) => { setIdentity(event.target.value); if (event.target.value === '亲情车') { setProofUpload(null); setProofApproved(false); } }} optionType="button" buttonStyle="solid" options={['住户车', '亲情车', '租户车', '小区服务车', '小区工作车'].map((value) => ({ value, label: value }))} /></div>
      {isFamily && <div className="parking-family-proof-box"><div><strong>亲情车证明材料</strong><Text type="secondary">有效期 1 小时，用户扫码上传图片或 PDF；资料提交后由管理员审核。</Text></div>{proofUpload?.status === 'submitted' ? <><Alert type="success" showIcon message="资料已上传，等待管理员审核" description={proofUpload.fileName || '已收到用户上传的证明材料。'} />{proofUpload.fileUrl && <a href={proofUpload.fileUrl} target="_blank" rel="noreferrer">查看已上传资料</a>}<Checkbox checked={proofApproved} onChange={(event) => setProofApproved(event.target.checked)}>管理员已审核证明材料，确认开通亲情车</Checkbox></> : <><Button type="primary" loading={proofLoading} disabled={normalized.length < 7} onClick={() => void createProof()} icon={<QrcodeOutlined />}>{proofUpload ? '重新生成二维码' : '生成 1 小时上传二维码'}</Button>{proofUpload?.qrDataUrl && <div className="parking-family-proof-qr"><img src={proofUpload.qrDataUrl} alt="亲情车证明材料上传二维码" /><Text type="secondary">请用户扫码上传，{new Date(proofUpload.expiresAt).toLocaleString('zh-CN', { hour12: false })} 前有效</Text></div>}</>}</div>}
      <Divider orientation="left">3 · 授权车库</Divider><div className="parking-new-form-section"><Text type="secondary">可多选。根据 PMS 房号已自动预选对应小区车库。</Text><Checkbox.Group className="parking-horizontal-options parking-garage-options" value={garages} onChange={(values) => setGarages(values as string[])} options={[{ value: 'phase1', label: '一期地面车库' }, { value: 'phase2', label: '二期地面车库' }, { value: 'main', label: '二期大车库' }, { value: 'civil', label: '二期人防车库' }]} /></div>
      <Divider orientation="left">4 · 缴费期限</Divider><div className="parking-new-form-section"><div className="parking-payment-row"><div><Text type="secondary">选择期限</Text><div className="parking-month-buttons">{[1, 2, 3, 6, 12].map((value) => <Button key={value} type={months === value ? 'primary' : 'default'} disabled={isFamily} onClick={() => setMonths(value)}>{value} 个月</Button>)}</div></div><div className="parking-new-amount"><small>按当前收费规则应收</small><strong>¥{amount.toFixed(2)}</strong><span>{isFamily ? '亲情车资料审核通过后再计费' : months === 12 ? '已按年付优惠价计算' : `${identity} · ¥${monthly}/月`}</span></div></div><div className="parking-rate-hint"><DollarOutlined /><span>收费规则：住户车 ¥180/月、¥1800/年；租户车 ¥260/月、¥2760/年。</span><Text type="secondary">请到续期页“收费规则”配置</Text></div></div>
      <div className="parking-new-drawer-actions"><Button onClick={() => setStep('plate')}>上一步</Button><Space><Button onClick={onClose}>取消</Button><Button type="primary" loading={loading || submittingCheck} onClick={() => void submit()}>{submittingCheck ? '正在提交前再次查重' : isFamily && (!proofUpload || proofUpload.status !== 'submitted' || !proofApproved) ? '暂存车牌，等待审核' : isFamily ? '审核通过并确认开通' : `确认登记并收费 ¥${amount.toFixed(2)}`}</Button></Space></div>
    </>}
    {task?.status === 'completed' && <Alert type="success" showIcon message={isFamily && task.payload.requiresProofReview ? '车牌已暂存，等待亲情车资料审核' : '新增车牌已完成'} description="车辆写入旧库后已读回验证。亲情车资料审核通过后，再调整授权车库使其正式开通。" />}
  </Drawer>;
}

function operationLabel(kind: accessCardIssuance.ParkingOperationKind): string {
  return ({ add_vehicle: '新增车牌', renew_vehicle: '车牌续期与收费', change_plate: '变更车牌', rebind_owner: '变更绑定用户', update_garages: '调整车库授权', download_vehicle: '下发停车设备', delete_vehicle: '注销车辆' } as Record<string, string>)[kind];
}

function garageBitString(keys: string[]): string {
  const channels: Record<string, number[]> = { phase1: [5, 7], phase2: [9, 11, 13], main: [15, 17, 19, 21] };
  const bits = Array.from({ length: 256 }, () => '0'); keys.forEach((key) => (channels[key] || []).forEach((channel) => { bits[channel - 1] = '1'; })); return bits.join('');
}

function OwnerDataPanel({ title, name, phone, room, note, editable, editHint, updatedAt, updateSource, onEdit }: {
  title: string; name: string; phone: string | null; room: string | null; note: string | null;
  editable: boolean; editHint?: string; updatedAt?: string | null; updateSource?: string | null; onEdit?: () => void;
}) {
  const updatedAtText = updatedAt && dayjs(updatedAt).isValid() ? dayjs(updatedAt).format('YYYY-MM-DD HH:mm') : null;
  const text = [
    `姓名：${name}`,
    `电话：${phone || '未记录'}`,
    `房号：${room || '未记录'}`,
    `备注：${note || '无'}`,
    ...(updatedAtText ? [`最后更新时间：${updatedAtText}`] : []),
    ...(updateSource ? [`更新来源：${updateSource}`] : []),
  ].join('\n');
  return <section className="parking-owner-panel">
    <header><strong>{title}</strong><Space size={4}>
      <Button size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(text)}>复制</Button>
      <Button size="small" icon={<EditOutlined />} disabled={!editable} title={editHint} onClick={onEdit}>编辑</Button>
    </Space></header>
    <dl><div><dt>姓名</dt><dd className="parking-owner-important">{name}</dd></div><div><dt>电话</dt><dd className="parking-owner-important">{phone || '未记录'}</dd></div><div><dt>房号</dt><dd>{room || '未记录'}</dd></div><div><dt>备注</dt><dd>{note || '无'}</dd></div>
      {updatedAtText && <div><dt>最后更新时间</dt><dd className="parking-owner-metadata">{updatedAtText}</dd></div>}
      {updateSource && <div><dt>更新来源</dt><dd className="parking-owner-metadata">{updateSource}</dd></div>}
    </dl>
    {!editable && editHint && <small>{editHint}</small>}
  </section>;
}

function legacyRoomFromName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^已隐藏\s*/, '');
  const match = /^(198|228)[/-](\d{1,2})[/-](\d{2,4})(?:[/-]\d+)?$/.exec(normalized);
  if (!match) return null;
  return `${match[1]}/${Number(match[2])}/${Number(match[3])}`;
}

function parkingExpiryView(value: string | null): { date: string; days: number | null } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return { date: value.replace(/\s+23:59:59$/, ''), days: null };
  const [year, month, day] = match.slice(1).map(Number);
  const expiryDate = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((expiryDate.getTime() - today.getTime()) / 86_400_000);
  return { date: `${match[1]}-${match[2]}-${match[3]}`, days };
}

function parkingSearchError(input: string): string | null {
  const term = input.trim();
  if (!term) return '请输入房号、住户姓名、电话或车牌';
  const address = term.replace(/\s+/g, '').replace(/[弄幢栋号]/g, '/').replace(/室$/g, '').replace(/\\/g, '/');
  if (/^(?:(?:198|228)[/-])?\d{1,2}[/-]\d{2,4}(?:[/-]\d+)?$/.test(address)) return null;
  const compact = term.replace(/\s+/g, '').toUpperCase();
  if (/^[\u4e00-\u9fff][A-Z][A-Z0-9挂学警港澳]{5,6}$/.test(compact)) return null;
  if (/^[A-Z0-9]{4,6}$/.test(compact)) return null;
  const digits = term.replace(/[\s-]/g, '');
  if (/^\d{7,11}$/.test(digits) || /^[\u4e00-\u9fff·]{2,20}$/.test(term)) return null;
  if (/^\d{1,6}$/.test(digits)) return '数字信息太少：查房号请输入“楼栋/室”，如 6/502；查车牌尾号至少输入 4 位；查电话至少输入 7 位';
  return '无法识别查询内容：请输入房号、住户姓名、7 位以上电话、完整车牌或至少 4 位车牌尾号';
}
