import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  ApartmentOutlined,
  AuditOutlined,
  CalculatorOutlined,
  CalendarOutlined,
  CarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DollarOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  HomeOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  PhoneOutlined,
  ReloadOutlined,
  RetweetOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SwapOutlined,
  SyncOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { accessCardIssuance, type AccessCardReadiness } from '@pms/api-client';
import CopyableSecret from '../components/CopyableSecret';
import './ParkingManagementPage.css';

const { Text, Title } = Typography;

type TargetCode =
  | 'phase1_parking'
  | 'phase2_parking'
  | 'phase2_main_garage'
  | 'phase2_civil_defense_garage';

type SyncState = 'synced' | 'pending' | 'failed' | 'disabled';

interface Authorization {
  target: TargetCode;
  enabled: boolean;
  space?: string;
  sync: SyncState;
  entry?: string;
  exit?: string;
  presence: '在场' | '已出场' | '未知' | '未开通';
}

interface Vehicle {
  id: number;
  plate: string;
  plateType: 'blue' | 'green';
  role: string;
  fuel: string;
  validUntil: string;
  space?: string;
  charge: string;
  latestEvent: string;
  authorizations: Authorization[];
}

const TARGET_META: Record<TargetCode, { short: string; full: string; billing: string }> = {
  phase1_parking: { short: '一期地面车库', full: '枫桦景苑一期地面车库', billing: '按车辆收费' },
  phase2_parking: { short: '二期地面车库', full: '枫桦景苑二期地面车库', billing: '按车辆收费' },
  phase2_main_garage: { short: '二期大车库', full: '枫桦景苑二期大车库', billing: '按车位收费' },
  phase2_civil_defense_garage: { short: '二期人防车库', full: '枫桦景苑二期人防车库', billing: '收费规则待确认' },
};

const INITIAL_VEHICLES: Vehicle[] = [
  {
    id: 1,
    plate: '沪A12345',
    plateType: 'blue',
    role: '业主车',
    fuel: '燃油车',
    validUntil: '2026-12-31',
    space: 'DK23',
    charge: '大车库管理费 · 按车位收费',
    latestEvent: '09-29 08:12 从二期大车库出场',
    authorizations: [
      { target: 'phase1_parking', enabled: true, sync: 'synced', entry: '09-28 18:35', exit: '09-29 08:12', presence: '已出场' },
      { target: 'phase2_parking', enabled: true, sync: 'synced', entry: '09-27 17:20', exit: '09-28 07:50', presence: '已出场' },
      { target: 'phase2_main_garage', enabled: true, space: 'DK23', sync: 'synced', entry: '09-28 18:36', exit: '09-29 08:10', presence: '已出场' },
      { target: 'phase2_civil_defense_garage', enabled: false, sync: 'disabled', presence: '未开通' },
    ],
  },
  {
    id: 2,
    plate: '沪AD86231',
    plateType: 'green',
    role: '租户车',
    fuel: '新能源车',
    validUntil: '2026-10-31',
    space: 'MF96',
    charge: '二期月租停车费 · 按车辆收费',
    latestEvent: '09-29 09:06 进入二期停车区',
    authorizations: [
      { target: 'phase1_parking', enabled: false, sync: 'disabled', presence: '未开通' },
      { target: 'phase2_parking', enabled: true, sync: 'synced', entry: '09-29 09:06', exit: '09-28 19:12', presence: '在场' },
      { target: 'phase2_main_garage', enabled: false, sync: 'disabled', presence: '未开通' },
      { target: 'phase2_civil_defense_garage', enabled: true, space: 'MF96', sync: 'failed', entry: '09-26 18:21', exit: '09-27 07:36', presence: '未知' },
    ],
  },
];

const SEARCH_RESULTS = [
  { key: '228/5/301', title: '228/5/301', subtitle: '枫桦景苑二期 · 5号楼 · 301室', resident: '张某某', phone: '138****6421', plates: ['沪A12345', '沪AD86231'], spaces: [{ type: '二期大车库', no: 'DK23' }, { type: '二期人防车库', no: 'MF96' }] },
  { key: '228/5/302', title: '228/5/302', subtitle: '枫桦景苑二期 · 5号楼 · 302室', resident: '陈某', phone: '136****1708', plates: ['沪B38126'], spaces: [] },
  { key: '198/24/601', title: '198/24/601', subtitle: '枫桦景苑一期 · 24号楼 · 601室', resident: '王某某', phone: '139****3876', plates: ['沪C66218'], spaces: [{ type: '二期大车库', no: 'DK08' }] },
];

function formatPlate(plate: string) {
  if (plate.length < 2) return plate;
  return `${plate.slice(0, 1)} ${plate.slice(1, 2)}·${plate.slice(2)}`;
}

function SyncTag({ state }: { state: SyncState }) {
  if (state === 'synced') return <Tag icon={<CheckCircleOutlined />} color="success">已同步</Tag>;
  if (state === 'pending') return <Tag icon={<ClockCircleOutlined />} color="processing">等待同步</Tag>;
  if (state === 'failed') return <Tag icon={<CloseCircleOutlined />} color="error">同步失败</Tag>;
  return <Tag>未开通</Tag>;
}

export default function ParkingManagementPage({ preview = false }: { preview?: boolean }) {
  const { message } = AntdApp.useApp();
  const [query, setQuery] = useState('');
  const [selectedHousehold, setSelectedHousehold] = useState(SEARCH_RESULTS[0]);
  const [vehicles, setVehicles] = useState(INITIAL_VEHICLES);
  const [tab, setTab] = useState('renewals');
  const [newVehicleOpen, setNewVehicleOpen] = useState(false);
  const [detailVehicle, setDetailVehicle] = useState<Vehicle | null>(null);
  const [readiness, setReadiness] = useState<AccessCardReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [gatewayModalOpen, setGatewayModalOpen] = useState(false);
  const [gatewayName, setGatewayName] = useState('枫桦景苑停车系统网关');
  const [gatewayEnrolling, setGatewayEnrolling] = useState(false);
  const [gatewayCredential, setGatewayCredential] = useState<{ id: string; token: string; message: string } | null>(null);

  const loadReadiness = async () => {
    setReadinessLoading(true);
    try {
      if (preview) {
        setReadiness({ simulationEnabled: true, features: { cardWrite: false, legacyDbWrite: false, accessDbWrite: false, parkingDbRead: true, parkingDbWrite: false, controllerUpload: false }, agents: [] });
      } else {
        setReadiness(await accessCardIssuance.readiness());
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停车网关状态加载失败');
    } finally {
      setReadinessLoading(false);
    }
  };

  useEffect(() => { void loadReadiness(); }, [preview]);

  const enrollParkingGateway = async () => {
    if (!gatewayName.trim()) {
      message.error('请填写这台电脑的名称');
      return;
    }
    setGatewayEnrolling(true);
    try {
      const result = preview
        ? { id: 'parking_gateway-preview12345678', token: '预览环境不会生成真实密钥', message: '预览凭据仅用于检查安装说明，不可连接 PMS' }
        : await accessCardIssuance.enrollAgent({ kind: 'parking_gateway', name: gatewayName.trim() });
      setGatewayCredential(result);
      if (!preview) await loadReadiness();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停车网关注册失败');
    } finally {
      setGatewayEnrolling(false);
    }
  };

  const filteredHouseholds = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return SEARCH_RESULTS;
    return SEARCH_RESULTS.filter((item) =>
      [item.title, item.subtitle, item.resident, item.phone, ...item.plates, ...item.spaces.flatMap((space) => [space.type, space.no])]
        .some((value) => value.toLowerCase().includes(key)),
    );
  }, [query]);

  const toggleAuthorization = (vehicleId: number, target: TargetCode, enabled: boolean) => {
    setVehicles((current) => current.map((vehicle) => vehicle.id !== vehicleId ? vehicle : {
      ...vehicle,
      authorizations: vehicle.authorizations.map((auth) => auth.target !== target ? auth : {
        ...auth,
        enabled,
        sync: enabled ? 'pending' : 'pending',
        presence: enabled ? auth.presence === '未开通' ? '未知' : auth.presence : '未知',
      }),
    }));
    message.info(enabled ? '已记下开通申请，提交时将只下发这一个目标' : '已记下撤销申请，不会删除车辆或车位资料');
  };

  const showWriteBlocked = () => {
    Modal.info({
      title: '已保留变更，当前未下发外部系统',
      content: (
        <div className="parking-confirm-copy">
          <p>页面交互已按调研结论完成，但一期、二期控制器和德立云的写入契约还没有通过受控测试。</p>
          <p>为避免生产车辆被误开通或误删除，当前只展示待变更状态，不会伪造“同步成功”。</p>
        </div>
      ),
      okText: '我知道了',
    });
  };

  const items = [
    { key: 'renewals', label: '续期', children: <RenewalsPanel vehicles={vehicles} onSubmit={showWriteBlocked} /> },
    { key: 'vehicles', label: '车辆与车库授权', children: <VehicleAuthorizationPanel vehicles={vehicles} onToggle={toggleAuthorization} onDetail={setDetailVehicle} onAdd={() => setNewVehicleOpen(true)} onSubmit={showWriteBlocked} /> },
    { key: 'spaces', label: '大车库车位管理', children: <SpacesPanel /> },
    { key: 'sync', label: <Badge dot offset={[7, 0]}>同步任务</Badge>, children: <SyncPanel /> },
    { key: 'reconciliation', label: <Badge count={3} size="small" offset={[9, 0]}>异常对账</Badge>, children: <ReconciliationPanel /> },
    { key: 'audit', label: '操作记录', children: <AuditPanel /> },
  ];
  const parkingGateways = readiness?.agents.filter((item) => item.kind === 'parking_gateway') ?? [];
  const parkingGateway = parkingGateways.find((item) => item.status === 'online')
    ?? [...parkingGateways].sort((left, right) =>
      new Date(right.lastSeenAt ?? 0).getTime() - new Date(left.lastSeenAt ?? 0).getTime())[0];

  return (
    <div className={`parking-page${preview ? ' is-preview' : ''}`}>
      <section className="parking-hero">
        <div>
          <div className="parking-eyebrow"><SafetyCertificateOutlined /> 统一车辆档案 · 四个独立授权目标</div>
          <Title level={1}>停车管理</Title>
          <Text>只维护一份住户和车辆资料，一期、二期、大车库和人防车库分别开通、续期和对账。</Text>
        </div>
        <div className="parking-hero-stats" aria-label="当前住户停车摘要">
          <div><span>车辆</span><strong>2</strong><small>辆</small></div>
          <div><span>车位</span><strong>2</strong><small>个</small></div>
          <div><span>异常</span><strong className="is-warning">1</strong><small>项</small></div>
        </div>
      </section>

      <Alert
        className="parking-integration-alert"
        type="warning"
        showIcon
        message="外部写入尚未开启"
        description="一期、二期本地系统和德立云正在进行受控契约验证。当前页面可完整评审业务流程，但不会向控制器或第三方系统写入数据。"
        action={<Button size="small" onClick={() => setTab('sync')}>查看验证项</Button>}
      />

      <Card className="parking-device-card" variant="borderless">
        <div className="parking-device-heading">
          <div>
            <span className="parking-section-kicker">设备与服务</span>
            <Title level={3}>Windows 本地停车网关</Title>
            <Text type="secondary">复用数据同步助手连接停车旧库；当前只读核验，确认写入契约后再开放下发。</Text>
          </div>
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={readinessLoading} onClick={() => void loadReadiness()}>重新检测</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setGatewayCredential(null); setGatewayModalOpen(true); }}>注册停车网关</Button>
          </Space>
        </div>
        <div className="parking-device-status">
          <span className={`parking-device-icon is-${parkingGateway?.status === 'online' ? 'online' : 'offline'}`}><DatabaseOutlined /></span>
          <div><strong>{parkingGateway?.name || '尚未连接停车网关'}</strong><small>{parkingGateway ? `版本 ${parkingGateway.version} · 最近心跳 ${parkingGateway.lastSeenAt ? new Date(parkingGateway.lastSeenAt).toLocaleString('zh-CN', { hour12: false }) : '暂无'}` : '在停车系统所在电脑安装数据同步助手后即可连接'}</small></div>
          <Tag color={parkingGateway?.status === 'online' ? 'success' : 'default'}>{parkingGateway?.status === 'online' ? '在线' : '未连接'}</Tag>
          <div className="parking-device-databases">
            <Tag color={parkingGateway?.status === 'online' && readiness?.features.parkingDbRead ? 'success' : 'default'} icon={parkingGateway?.status === 'online' && readiness?.features.parkingDbRead ? <CheckCircleOutlined /> : <DatabaseOutlined />}>
              枫桦景苑一期 {parkingGateway?.status === 'online' && readiness?.features.parkingDbRead ? '已连接' : '未验证'}
            </Tag>
            <Tag color={parkingGateway?.status === 'online' && readiness?.features.parkingDbRead ? 'success' : 'default'} icon={parkingGateway?.status === 'online' && readiness?.features.parkingDbRead ? <CheckCircleOutlined /> : <DatabaseOutlined />}>
              枫桦景苑二期 {parkingGateway?.status === 'online' && readiness?.features.parkingDbRead ? '已连接' : '未验证'}
            </Tag>
            <Tag color={readiness?.features.parkingDbRead ? 'blue' : 'default'}>只读探测</Tag><Tag>写入未开放</Tag>
          </div>
        </div>
      </Card>

      <Card className="parking-resident-card" variant="borderless">
        <div className="parking-resident-search">
          <div>
            <span className="parking-section-kicker">1 · 先选住户</span>
            <Title level={3}>查找房号或住户</Title>
            <Text type="secondary">支持房号、姓名、手机号或车牌号</Text>
          </div>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：228/5/301、张某某、138或沪A12345"
            aria-label="搜索房号、住户、手机号或车牌号"
          />
        </div>
        <div className="parking-household-results">
          {filteredHouseholds.map((household) => (
            <button
              type="button"
              key={household.key}
              className={`parking-household-option${selectedHousehold.key === household.key ? ' is-selected' : ''}`}
              onClick={() => setSelectedHousehold(household)}
            >
              <span className="parking-house-icon"><HomeOutlined /></span>
              <span className="parking-house-main"><strong>{household.title}</strong><small>{household.subtitle}</small></span>
              <span className="parking-house-resident"><UserOutlined /> {household.resident}<small>{household.phone}</small></span>
              <span className="parking-house-assets">
                <span><CarOutlined /> {household.plates.map((plate) => <Tag key={plate}>{plate}</Tag>)}</span>
                {household.spaces.length > 0 && <span><ApartmentOutlined /> {household.spaces.map((space) => <Tag color="blue" key={`${space.type}-${space.no}`}>{space.type} {space.no}</Tag>)}</span>}
              </span>
            </button>
          ))}
          {filteredHouseholds.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的住户" />}
        </div>
      </Card>

      <section className="parking-resident-summary">
        <div className="parking-resident-title">
          <span><CheckCircleOutlined /> 已选住户</span>
          <Title level={2}>{selectedHousehold.title}</Title>
          <Text>{selectedHousehold.subtitle} · 住户：{selectedHousehold.resident}</Text>
        </div>
        <div className="parking-space-summary">
          <SpaceSummary type="main" number="DK23" relation="产权车位" fee="管理费至 2026-12-31" bind="已绑定 沪A12345" />
          <SpaceSummary type="civil" number="MF96" relation="使用车位" fee="月租至 2026-10-31" bind="已绑定 沪AD86231" />
        </div>
      </section>

      <Card className="parking-workbench" variant="borderless">
        <Tabs activeKey={tab} onChange={setTab} items={items} />
      </Card>

      <NewVehicleDrawer
        open={newVehicleOpen}
        onClose={() => setNewVehicleOpen(false)}
        onQueryPlate={(plate) => {
          setNewVehicleOpen(false);
          setQuery(plate);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />
      <VehicleDetailDrawer vehicle={detailVehicle} onClose={() => setDetailVehicle(null)} />
      <Modal
        title="注册停车系统本地网关"
        open={gatewayModalOpen}
        width={650}
        onCancel={() => setGatewayModalOpen(false)}
        footer={gatewayCredential
          ? <Button type="primary" onClick={() => setGatewayModalOpen(false)}>我已保存安装信息</Button>
          : <Space><Button onClick={() => setGatewayModalOpen(false)}>取消</Button><Button type="primary" loading={gatewayEnrolling} onClick={() => void enrollParkingGateway()}>生成一次性密钥</Button></Space>}
      >
        {gatewayCredential ? (
          <div className="parking-gateway-secret">
            <Alert type="warning" showIcon message="密钥只显示这一次" description={gatewayCredential.message} />
            <CopyableSecret label="一次性连接密钥" value={gatewayCredential.token} />
            <Text type="secondary">在停车电脑双击数据同步助手，只需粘贴上方连接密钥。代理 ID 已包含在密钥中，不要截图或转发。</Text>
          </div>
        ) : (
          <div className="parking-gateway-form">
            <Alert type="info" showIcon message="服务类型已固定为停车系统网关" description="一次性密钥由 PMS 生成；数据库密码只在本机加密保存，不会上传到 PMS。" />
            <label htmlFor="parking-gateway-name">电脑名称</label>
            <Input id="parking-gateway-name" value={gatewayName} maxLength={100} onChange={(event) => setGatewayName(event.target.value)} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function SpaceSummary({ type, number, relation, fee, bind }: { type: 'main' | 'civil'; number: string; relation: string; fee: string; bind: string }) {
  return (
    <article>
      <span className="parking-space-icon"><ApartmentOutlined /></span>
      <div><small>{type === 'main' ? '二期大车库' : '二期人防车库'}</small><strong>{number}</strong></div>
      <div><Tag color={type === 'main' ? 'blue' : 'cyan'}>{relation}</Tag><span>{fee}</span></div>
      <div className="parking-space-bind">{bind}</div>
    </article>
  );
}

function VehicleAuthorizationPanel({ vehicles, onToggle, onDetail, onAdd, onSubmit }: {
  vehicles: Vehicle[];
  onToggle: (vehicleId: number, target: TargetCode, enabled: boolean) => void;
  onDetail: (vehicle: Vehicle) => void;
  onAdd: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="parking-panel-stack">
      <div className="parking-panel-heading">
        <div><span className="parking-section-kicker">2 · 车辆与授权</span><Title level={3}>名下车辆</Title><Text type="secondary">取消勾选只撤销对应停车区权限，不删除车辆、车位或产权。</Text></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>登记新车</Button>
      </div>
      <div className="parking-vehicle-list">
        {vehicles.map((vehicle) => (
          <VehicleCard key={vehicle.id} vehicle={vehicle} onToggle={onToggle} onDetail={onDetail} />
        ))}
      </div>
      <div className="parking-save-bar">
        <div><strong>所有变更都会按目标独立创建任务</strong><span>单个目标失败不会掩盖为整体成功，也不会回滚已生效目标。</span></div>
        <Button type="primary" size="large" onClick={onSubmit}>预览并提交变更</Button>
      </div>
    </div>
  );
}

function VehicleCard({ vehicle, onToggle, onDetail }: { vehicle: Vehicle; onToggle: (vehicleId: number, target: TargetCode, enabled: boolean) => void; onDetail: (vehicle: Vehicle) => void }) {
  const syncedCount = vehicle.authorizations.filter((item) => item.enabled && item.sync === 'synced').length;
  return (
    <article className="parking-vehicle-card">
      <div className="parking-vehicle-identity">
        <div className={`parking-license-plate is-${vehicle.plateType}`} aria-label={`${vehicle.plateType === 'blue' ? '蓝牌' : '绿牌'} ${vehicle.plate}`}>
          <span>{formatPlate(vehicle.plate)}</span>
        </div>
        <div className="parking-vehicle-meta"><strong>{vehicle.role} · {vehicle.fuel}</strong><span><CalendarOutlined /> 统一到期：{vehicle.validUntil}</span>{vehicle.space && <span><ApartmentOutlined /> 绑定车位：{vehicle.space}</span>}<span>{vehicle.charge}</span></div>
        <div className="parking-vehicle-event"><small>最近进出</small><strong>{vehicle.latestEvent}</strong><button type="button" onClick={() => onDetail(vehicle)}>查看各停车区记录</button></div>
      </div>
      <div className="parking-auth-grid">
        {vehicle.authorizations.map((auth) => (
          <div className={`parking-auth-item${auth.enabled ? ' is-enabled' : ''}`} key={auth.target}>
            <div className="parking-auth-check">
              <Checkbox checked={auth.enabled} onChange={(event) => onToggle(vehicle.id, auth.target, event.target.checked)}>
                <strong>{TARGET_META[auth.target].short}</strong>
              </Checkbox>
              <SyncTag state={auth.sync} />
            </div>
            <div className="parking-auth-fields">
              {auth.target.includes('garage') && <label><span>车位</span><Select size="small" disabled={!auth.enabled} value={auth.space} placeholder="选择车位" options={[{ value: 'DK23' }, { value: 'MF96' }]} /></label>}
              <label><span>收费方式</span><Text>{TARGET_META[auth.target].billing}</Text></label>
            </div>
          </div>
        ))}
      </div>
      <div className="parking-vehicle-footer">
        <span><CheckCircleOutlined /> {syncedCount} 个目标已同步</span>
        {vehicle.authorizations.some((item) => item.sync === 'failed') && <span className="is-error"><ExclamationCircleOutlined /> 1 个目标需要重试</span>}
        <Button icon={<SwapOutlined />}>换车</Button>
        <Button icon={<EditOutlined />} onClick={() => onDetail(vehicle)}>车辆详情</Button>
      </div>
    </article>
  );
}

function NewVehicleDrawer({ open, onClose, onQueryPlate }: { open: boolean; onClose: () => void; onQueryPlate: (plate: string) => void }) {
  const [plate, setPlate] = useState('沪A');
  const [step, setStep] = useState<'plate' | 'details'>('plate');
  const [householdKey, setHouseholdKey] = useState(SEARCH_RESULTS[0].key);
  const [identity, setIdentity] = useState('住户车');
  const [months, setMonths] = useState(1);
  const [garages, setGarages] = useState<string[]>(['phase2_parking']);
  const [fieldPhone, setFieldPhone] = useState('');
  const [phoneOverride, setPhoneOverride] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [rules, setRules] = useState({ ownerMonthly: 180, ownerAnnual: 1800, tenantMonthly: 260, tenantAnnual: 2760 });
  const [checking, setChecking] = useState(false);
  const normalized = plate.replace(/[\s·]/g, '').toUpperCase().slice(0, 8);
  const isGreen = normalized.length === 8;
  const household = SEARCH_RESULTS.find((item) => item.key === householdKey) || SEARCH_RESULTS[0];
  const monthly = identity === '租户车' ? rules.tenantMonthly : identity === '亲情车' ? 0 : rules.ownerMonthly;
  const annual = identity === '租户车' ? rules.tenantAnnual : identity === '亲情车' ? 0 : rules.ownerAnnual;
  const amount = months === 12 ? annual : monthly * months;

  useEffect(() => {
    if (!open) return;
    setStep('plate');
    setPlate('沪A');
    setHouseholdKey(SEARCH_RESULTS[0].key);
    setIdentity('住户车');
    setMonths(1);
    setGarages(['phase2_parking']);
    setFieldPhone('');
    setPhoneOverride(false);
    setRateOpen(false);
  }, [open]);

  useEffect(() => {
    if (normalized.length < 2) return;
    setChecking(true);
    const timer = window.setTimeout(() => setChecking(false), 300);
    return () => window.clearTimeout(timer);
  }, [normalized]);

  const append = (char: string) => setPlate((value) => `${value}${char}`.replace(/[\s·]/g, '').toUpperCase().slice(0, 8));
  const isExisting = normalized === '沪A12345' || normalized === '沪AD86231';
  const chooseHousehold = (key: string) => {
    setHouseholdKey(key);
    setGarages(key.startsWith('198/') ? ['phase1_parking'] : ['phase2_parking']);
  };

  return (
    <Drawer className="parking-new-drawer" width={760} open={open} onClose={onClose} title="新增车牌" destroyOnClose={false} extra={<Tag color="blue">{step === 'plate' ? '1 / 2 车牌查重' : '2 / 2 登记资料'}</Tag>}>
      <div className="parking-new-flow"><span className={step === 'plate' ? 'is-current' : 'is-done'}>1 <small>车牌查重</small></span><i /><span className={step === 'details' ? 'is-current' : ''}>2 <small>登记资料</small></span></div>
      {step === 'plate' ? <>
        <Alert type="info" showIcon message="先输入车牌，再补充登记资料" description="系统会同时查询 PMS、一期和二期旧库，确认没有精确重复后才能继续。" />
        <div className="parking-plate-entry parking-plate-entry-design">
          <label htmlFor="parking-plate-input">车牌号码</label>
          <Input id="parking-plate-input" size="large" value={normalized} onChange={(event) => setPlate(event.target.value.replace(/[\s·]/g, '').toUpperCase().slice(0, 8))} suffix={checking ? <SyncOutlined spin /> : <CheckCircleOutlined />} placeholder="请输入车牌，例如 沪A12345" />
          <div className={`parking-license-plate is-${isGreen ? 'green' : 'blue'} is-large`}><span>{formatPlate(normalized || '沪A')}</span></div>
          <Text type="secondary"><InfoCircleOutlined /> 支持鼠标点击下方键盘，也支持电脑键盘直接输入。</Text>
        </div>
        <PlateKeyboard onKey={append} onBackspace={() => setPlate((value) => value.slice(0, -1))} onClear={() => setPlate('')} />
        <div className="parking-duplicate-result" aria-live="polite">
          {checking ? <div className="parking-checking"><SyncOutlined spin /> 正在跨系统查询…</div> : isExisting ? (
            <Alert type="warning" showIcon message="该车牌已属于当前住户" description="不重复创建车辆。可直接查询现有车辆，为它增加其他停车区权限。" action={<Button type="primary" icon={<SearchOutlined />} onClick={() => onQueryPlate(normalized)}>查询此车牌</Button>} />
          ) : normalized.length >= 7 ? (
            <Alert type="success" showIcon message="四个来源均未发现精确重复" description="最终提交时服务端会再次精确查重。" />
          ) : <Text type="secondary">继续输入完整车牌，系统会自动开始查重。</Text>}
        </div>
        <div className="parking-new-drawer-actions"><Button onClick={onClose}>取消</Button><Button type="primary" disabled={normalized.length < 7 || isExisting} onClick={() => setStep('details')}>继续登记资料</Button></div>
      </> : <>
        <div className="parking-new-plate-summary"><div className={`parking-license-plate is-${isGreen ? 'green' : 'blue'}`}><span>{formatPlate(normalized)}</span></div><div><strong>新车登记</strong><Text type="secondary">车牌已通过精确查重，可继续填写授权与收费信息。</Text></div></div>
        <Divider orientation="left">1 · PMS 房号与住户</Divider>
        <div className="parking-new-form-section">
          <label>PMS 房号<Select showSearch value={householdKey} optionFilterProp="label" onChange={chooseHousehold} options={SEARCH_RESULTS.map((item) => ({ value: item.key, label: `${item.title} · ${item.resident}` }))} /></label>
          <div className="parking-pms-resident-card"><span className="parking-pms-resident-icon"><HomeOutlined /></span><div><strong>{household.title}</strong><Text>{household.subtitle}</Text></div><div><small>姓名</small><strong>{household.resident}</strong></div><div><small>电话</small><strong>{household.phone}</strong></div></div>
          {!phoneOverride ? <Button type="link" icon={<PhoneOutlined />} onClick={() => setPhoneOverride(true)}>现场电话不一致？填写停车登记电话</Button> : <div className="parking-phone-override"><label>现场登记电话<Input value={fieldPhone} onChange={(event) => setFieldPhone(event.target.value)} placeholder="输入现场提供的新电话" /></label><Text type="secondary">将记录为“{dayjs().format('YYYY-MM-DD HH:mm')} 停车登记电话”；写入旧库时房号统一规范为 {household.title}。</Text></div>}
        </div>
        <Divider orientation="left">2 · 车辆授权类型</Divider>
        <div className="parking-new-form-section"><Text type="secondary">授权类型决定收费规则，默认按住户车计价。</Text><Radio.Group className="parking-horizontal-options" value={identity} onChange={(event) => setIdentity(event.target.value)} optionType="button" buttonStyle="solid" options={['住户车', '亲情车', '租户车', '小区服务车', '小区工作车'].map((value) => ({ value, label: value }))} /></div>
        <Divider orientation="left">3 · 授权车库</Divider>
        <div className="parking-new-form-section"><Text type="secondary">可多选。根据 PMS 房号已自动预选对应小区车库，二期大车库和人防车库可另外开通。</Text><Checkbox.Group className="parking-horizontal-options parking-garage-options" value={garages} onChange={(values) => setGarages(values as string[])} options={[{ value: 'phase1_parking', label: '一期地面车库' }, { value: 'phase2_parking', label: '二期地面车库' }, { value: 'phase2_main_garage', label: '二期大车库' }, { value: 'phase2_civil_defense_garage', label: '二期人防车库' }]} /></div>
        <Divider orientation="left">4 · 缴费期限</Divider>
        <div className="parking-new-form-section"><div className="parking-payment-row"><div><Text type="secondary">选择期限</Text><div className="parking-month-buttons">{[1, 2, 3, 6, 12].map((value) => <Button key={value} type={months === value ? 'primary' : 'default'} onClick={() => setMonths(value)}>{value} 个月</Button>)}</div></div><div className="parking-new-amount"><small>按当前收费规则应收</small><strong>¥{amount.toFixed(2)}</strong><span>{months === 12 ? '已按年付优惠价计算' : `${identity} · ¥${monthly}/月`}</span></div></div><div className="parking-rate-hint"><DollarOutlined /><span>收费规则：住户车 ¥{rules.ownerMonthly}/月、¥{rules.ownerAnnual}/年；租户车 ¥{rules.tenantMonthly}/月、¥{rules.tenantAnnual}/年。</span><Button type="link" size="small" onClick={() => setRateOpen(true)}>查看 / 配置收费规则</Button></div></div>
        <div className="parking-new-drawer-actions"><Button onClick={() => setStep('plate')}>上一步</Button><Space><Button onClick={onClose}>取消</Button><Button type="primary" onClick={onClose}>确认登记并收费 ¥{amount.toFixed(2)}</Button></Space></div>
      </>}
      <Modal title="停车收费规则配置" open={rateOpen} onCancel={() => setRateOpen(false)} onOk={() => setRateOpen(false)} okText="保存规则" cancelText="取消" width={620}>
        <Alert type="info" showIcon message="按车辆授权类型分别计价" description="缴费期限选择 12 个月时使用年付价；其他期限按月单价计算。" />
        <div className="parking-rate-grid">
          <section><div className="parking-rate-title"><HomeOutlined /> <strong>住户车</strong></div><label>月单价（元）<InputNumber min={0} precision={2} value={rules.ownerMonthly} onChange={(value) => setRules((current) => ({ ...current, ownerMonthly: Number(value || 0) }))} /></label><label>12 个月年付价（元）<InputNumber min={0} precision={2} value={rules.ownerAnnual} onChange={(value) => setRules((current) => ({ ...current, ownerAnnual: Number(value || 0) }))} /></label></section>
          <section><div className="parking-rate-title"><UserOutlined /> <strong>租户车</strong></div><label>月单价（元）<InputNumber min={0} precision={2} value={rules.tenantMonthly} onChange={(value) => setRules((current) => ({ ...current, tenantMonthly: Number(value || 0) }))} /></label><label>12 个月年付价（元）<InputNumber min={0} precision={2} value={rules.tenantAnnual} onChange={(value) => setRules((current) => ({ ...current, tenantAnnual: Number(value || 0) }))} /></label></section>
        </div>
      </Modal>
    </Drawer>
  );
}

function PlateKeyboard({ onKey, onBackspace, onClear }: { onKey: (key: string) => void; onBackspace: () => void; onClear: () => void }) {
  const keys = '沪苏浙皖京粤鲁豫ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789'.split('');
  return (
    <div className="parking-plate-keyboard">
      <div className="parking-key-grid">{keys.map((key) => <button type="button" key={key} onClick={() => onKey(key)}>{key}</button>)}</div>
      <div className="parking-key-actions"><Button onClick={onBackspace}>退格</Button><Button danger onClick={onClear}>清空</Button></div>
    </div>
  );
}

function VehicleDetailDrawer({ vehicle, onClose }: { vehicle: Vehicle | null; onClose: () => void }) {
  return (
    <Drawer width={760} open={!!vehicle} onClose={onClose} title={vehicle ? `${vehicle.plate} · 各停车区记录` : '车辆详情'}>
      {vehicle && <div className="parking-detail-list">
        <Alert type="info" showIcon message={`车辆统一到期日：${vehicle.validUntil}`} description="到期日属于车辆，所有已开通停车区共用，不再按车库分开维护。" />
        {vehicle.authorizations.map((auth) => <article key={auth.target}><div><strong>{TARGET_META[auth.target].full}</strong><SyncTag state={auth.sync} /></div><dl><div><dt>最后入库</dt><dd>{auth.entry || '—'}</dd></div><div><dt>最后出库</dt><dd>{auth.exit || '—'}</dd></div><div><dt>当前状态</dt><dd>{auth.presence}</dd></div></dl></article>)}
      </div>}
    </Drawer>
  );
}

function SpacesPanel() {
  const spaces = [
    { no: 'DK23', type: '大车库', owner: '228/5/301 张某某', relation: '产权', vehicle: '沪A12345', state: '已分配 · 当前空闲', tone: 'blue' },
    { no: 'MF96', type: '人防车库', owner: '228/5/301 张某某', relation: '长期使用', vehicle: '沪AD86231', state: '已分配 · 状态未知', tone: 'gold' },
    { no: 'DK24', type: '大车库', owner: '未分配', relation: '—', vehicle: '—', state: '空置', tone: 'green' },
  ];
  return <div className="parking-panel-stack"><div className="parking-panel-heading"><div><span className="parking-section-kicker">车位台账</span><Title level={3}>大车库与人防车位</Title><Text type="secondary">“已分配”是产权/使用关系，“已占用”是实际停车状态，两者分开管理。</Text></div><Button type="primary" icon={<PlusOutlined />}>新增车位</Button></div><div className="parking-space-list">{spaces.map((space) => <article key={space.no}><div className="parking-space-number"><small>{space.type}</small><strong>{space.no}</strong></div><dl><div><dt>产权 / 使用住户</dt><dd>{space.owner}</dd></div><div><dt>关系</dt><dd>{space.relation}</dd></div><div><dt>绑定车辆</dt><dd>{space.vehicle}</dd></div></dl><Tag color={space.tone}>{space.state}</Tag><Button icon={<EditOutlined />}>维护</Button></article>)}</div></div>;
}

interface ParkingRateRules {
  ownerMonthly: number;
  ownerAnnual: number;
  tenantMonthly: number;
  tenantAnnual: number;
}

function RenewalsPanel({ vehicles, onSubmit }: { vehicles: Vehicle[]; onSubmit: () => void }) {
  const [months, setMonths] = useState(12);
  const [selected, setSelected] = useState<number[]>([2]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [calcRole, setCalcRole] = useState<'owner' | 'tenant'>('owner');
  const [calcMonths, setCalcMonths] = useState(12);
  const [rules, setRules] = useState<ParkingRateRules>({
    ownerMonthly: 180,
    ownerAnnual: 1800,
    tenantMonthly: 260,
    tenantAnnual: 2760,
  });

  const calculateFee = (role: 'owner' | 'tenant', duration: number) => {
    const monthly = role === 'owner' ? rules.ownerMonthly : rules.tenantMonthly;
    const annual = role === 'owner' ? rules.ownerAnnual : rules.tenantAnnual;
    const fullYears = Math.floor(duration / 12);
    const extraMonths = duration % 12;
    return fullYears * annual + extraMonths * monthly;
  };

  const calcAmount = calculateFee(calcRole, calcMonths);
  const calcRegular = (calcRole === 'owner' ? rules.ownerMonthly : rules.tenantMonthly) * calcMonths;

  return (
    <div className="parking-panel-stack">
      <div className="parking-panel-heading parking-renewal-heading">
        <div>
          <span className="parking-section-kicker">续期</span>
          <Title level={3}>车辆到期与收费</Title>
          <Text type="secondary">每辆车只有一个到期日，已开通的停车区共用。续期从当前到期日往后顺延。</Text>
        </div>
        <Space wrap>
          <Button icon={<DollarOutlined />} onClick={() => setRulesOpen(true)}>收费规则</Button>
          <Button icon={<CalculatorOutlined />} onClick={() => setCalculatorOpen(true)}>缴费验算</Button>
        </Space>
      </div>

      <div className="parking-renewal-toolbar">
        <div>
          <span className="parking-field-caption"><CalendarOutlined /> 快捷续期时长</span>
          <div className="parking-month-buttons">
            {[1, 2, 3, 6, 12].map((value) => (
              <Button key={value} type={months === value ? 'primary' : 'default'} onClick={() => setMonths(value)}>{value} 个月</Button>
            ))}
          </div>
        </div>
        <div className="parking-renewal-selection">
          <span>已选 {selected.length} 辆车 · 续期 {months} 个月</span>
          <Button type="primary" size="large" disabled={selected.length === 0} onClick={onSubmit}>确认续期并收费</Button>
        </div>
      </div>

      <div className="parking-renewal-list">
        {vehicles.map((vehicle) => {
          const role = vehicle.role === '租户车' ? 'tenant' : 'owner';
          const checked = selected.includes(vehicle.id);
          const nextDate = dayjs(vehicle.validUntil).add(months, 'month').format('YYYY-MM-DD');
          return (
            <article key={vehicle.id} className={checked ? 'is-selected' : ''}>
              <Checkbox checked={checked} onChange={(event) => setSelected((current) => event.target.checked ? [...current, vehicle.id] : current.filter((id) => id !== vehicle.id))} />
              <div className={`parking-license-plate is-${vehicle.plateType}`}><span>{formatPlate(vehicle.plate)}</span></div>
              <div className="parking-renewal-role"><strong>{vehicle.role}</strong><span>{role === 'owner' ? '业主车收费规则' : '租户车收费规则'}</span></div>
              <div><small>当前到期</small><strong>{vehicle.validUntil}</strong></div>
              <div><small>续期后</small><strong>{nextDate}</strong></div>
              <div className="parking-renewal-fee"><small>应收</small><strong>¥{calculateFee(role, months).toFixed(2)}</strong>{months >= 12 && <Tag color="success">已含年付优惠</Tag>}</div>
            </article>
          );
        })}
      </div>

      <Modal title="停车收费规则" open={rulesOpen} onCancel={() => setRulesOpen(false)} onOk={() => setRulesOpen(false)} okText="保存规则" cancelText="取消" width={680}>
        <Alert type="info" showIcon message="业主车和租户车分开计价" description="12 个月使用年付价；其他时长按月单价计算。" />
        <div className="parking-rate-grid">
          <section><div className="parking-rate-title"><HomeOutlined /> <strong>业主车</strong></div><label>月单价（元）<InputNumber min={0} precision={2} value={rules.ownerMonthly} onChange={(value) => setRules((current) => ({ ...current, ownerMonthly: Number(value || 0) }))} /></label><label>12 个月年付价（元）<InputNumber min={0} precision={2} value={rules.ownerAnnual} onChange={(value) => setRules((current) => ({ ...current, ownerAnnual: Number(value || 0) }))} /></label><Text type="secondary">年付优惠 ¥{Math.max(0, rules.ownerMonthly * 12 - rules.ownerAnnual).toFixed(2)}</Text></section>
          <section><div className="parking-rate-title"><UserOutlined /> <strong>租户车</strong></div><label>月单价（元）<InputNumber min={0} precision={2} value={rules.tenantMonthly} onChange={(value) => setRules((current) => ({ ...current, tenantMonthly: Number(value || 0) }))} /></label><label>12 个月年付价（元）<InputNumber min={0} precision={2} value={rules.tenantAnnual} onChange={(value) => setRules((current) => ({ ...current, tenantAnnual: Number(value || 0) }))} /></label><Text type="secondary">年付优惠 ¥{Math.max(0, rules.tenantMonthly * 12 - rules.tenantAnnual).toFixed(2)}</Text></section>
        </div>
      </Modal>

      <Modal title="缴费验算" open={calculatorOpen} onCancel={() => setCalculatorOpen(false)} footer={<Button type="primary" onClick={() => setCalculatorOpen(false)}>完成</Button>} width={560}>
        <div className="parking-calculator">
          <label>车辆类型<Select value={calcRole} onChange={setCalcRole} options={[{ value: 'owner', label: '业主车' }, { value: 'tenant', label: '租户车' }]} /></label>
          <label>缴费时长<Select value={calcMonths} onChange={setCalcMonths} options={[1, 2, 3, 6, 12, 24].map((value) => ({ value, label: `${value} 个月` }))} /></label>
          <div className="parking-calculator-result"><span>应收金额</span><strong>¥{calcAmount.toFixed(2)}</strong><small>{calcMonths >= 12 ? `已使用年付优惠，比按月缴费节省 ¥${Math.max(0, calcRegular - calcAmount).toFixed(2)}` : `按月单价计算，共 ${calcMonths} 个月`}</small></div>
        </div>
      </Modal>
    </div>
  );
}

function SyncPanel() {
  const systems = [{ name: '一期本地停车', state: '只读验证待完成', percent: 40 }, { name: '二期本地停车', state: '大车库设备映射待确认', percent: 32 }, { name: '德立云人防车库', state: '当前停车 API 契约待验证', percent: 24 }];
  return <div className="parking-panel-stack"><Alert type="info" showIcon message="同步状态以 PMS 自己的目标级任务流水为准" description="旧库单个状态字段不能证明控制器已经成功接收。每个目标都需要记录请求、尝试、回执和最后错误。" /><div className="parking-system-grid">{systems.map((system) => <Card key={system.name} size="small"><div className="parking-system-title"><DatabaseOutlined /><strong>{system.name}</strong></div><Progress percent={system.percent} status="active" /><Text type="secondary">{system.state}</Text><Button block icon={<ToolOutlined />}>查看受控验证清单</Button></Card>)}</div><Card size="small" title="失败任务"><div className="parking-failed-task"><CloseCircleOutlined /><div><strong>沪AD86231 · 二期人防车库</strong><span>失败阶段：查询车位池绑定 · 错误编号 P9A31F2C</span></div><Button icon={<ReloadOutlined />}>只重试该目标</Button></div></Card></div>;
}

function ReconciliationPanel() {
  const rows = [{ plate: '沪A12345', issue: '到期日不一致', pms: '2026-12-31', outside: '二期 2026-11-30' }, { plate: '沪B812S5', issue: '外部存在，PMS 未登记', pms: '未登记', outside: '一期在用' }, { plate: '沪AD86231', issue: '最后进出事件超时', pms: '09-29 09:06', outside: '人防事件未同步' }];
  return <div className="parking-panel-stack"><Alert type="warning" showIcon message="差异不会被自动覆盖" description="管理员需确认“以 PMS 修复外部”或“将外部现状认领进 PMS”，避免破坏历史业务资料。" /><div className="parking-reconcile-list">{rows.map((row) => <article key={`${row.plate}${row.issue}`}><div className="parking-license-plate is-blue"><span>{formatPlate(row.plate)}</span></div><div><strong>{row.issue}</strong><span>PMS：{row.pms}</span><span>外部：{row.outside}</span></div><Space wrap><Button>查看差异</Button><Button type="primary">选择修复方式</Button></Space></article>)}</div></div>;
}

function AuditPanel() {
  return <div className="parking-audit"><Timeline items={[{ color: 'blue', dot: <RetweetOutlined />, children: <><strong>09-29 10:42 · 张管理员</strong><p>申请重试 沪AD86231 的“二期人防车库”授权，其他目标未变更。</p><Tag color="error">外部失败 · P9A31F2C</Tag></> }, { color: 'green', dot: <CheckCircleOutlined />, children: <><strong>09-29 09:15 · 李收费员</strong><p>登记 DK23 2026 年度大车库管理费，收费主体为车位。</p><Tag color="success">已收费</Tag></> }, { color: 'gray', dot: <AuditOutlined />, children: <><strong>09-28 17:50 · 王管理员</strong><p>将沪A12345 的二期停车权限续期至 2026-11-30。</p><Tag>已同步</Tag></> }]} /></div>;
}
