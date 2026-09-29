import {
  Alert,
  App as AntdApp,
  Button,
  Card,
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
  HomeOutlined,
  PhoneOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  accessCardIssuance,
  type AccessCardReadiness,
} from '@pms/api-client';
import { useCallback, useEffect, useState } from 'react';
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
  const canQuery = canRead && supportsParkingQueries(gateway?.version);

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
        message={canQuery ? '停车数据库真实查询已就绪' : online ? '停车网关需要升级' : '尚未接通真实停车数据'}
        description={canQuery
          ? '查询会实时读取现场 parking1、parking2 的 Car_Issue 表；当前仍为只读，不会修改旧系统。'
          : online
            ? `现场网关版本为 ${gateway?.version || '未知'}，升级 Windows 数据同步助手到 0.4.0 后即可查询。`
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
            <Tag icon={<DatabaseOutlined />}>parking1</Tag>
            <Tag icon={<DatabaseOutlined />}>parking2</Tag>
            <Tag color={canQuery ? 'success' : canRead ? 'gold' : 'default'}>{canQuery ? '查询已就绪' : canRead ? '需升级助手' : '尚未验证'}</Tag>
            <Tag>写入未开放</Tag>
          </div>
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
            <div className="parking-query-summary"><CheckCircleOutlined /> 找到 {rows.length} 条与“{searchedTerm}”匹配的真实记录</div>
            {rows.map((row, index) => <ParkingResultCard key={`${row.database}-${index}`} row={row} />)}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={searchedTerm
              ? `没有查到与“${searchedTerm}”匹配的停车记录`
              : canQuery ? '输入房号、住户、电话或车牌开始查询' : online ? '网关已连接，请升级 Windows 助手到 0.4.0' : '未连接真实停车数据库，不显示模拟数据'}
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
    </div>
  );
}

function supportsParkingQueries(version?: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 4));
}

const fieldAliases = {
  plate: ['carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌'],
  owner: ['ownername', 'carname', 'username', 'customername', 'personname', '姓名', '车主', '住户'],
  room: ['roomno', 'roomnumber', 'houseno', 'address', 'addr', 'room', '房号', '地址'],
  phone: ['mobile', 'telephone', 'phone', 'tel', '手机', '电话'],
  space: ['parkno', 'parkingno', 'spaceno', 'berth', 'garage', '车位', '地库'],
  expiry: ['enddate', 'expiredate', 'expirydate', 'validto', 'deadline', 'overdate', 'endtime', '到期', '有效期'],
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

function ParkingResultCard({ row }: { row: ParkingQueryRow }) {
  const plate = plateValue(row.fields);
  const owner = fieldValue(row.fields, fieldAliases.owner) || '未记录住户姓名';
  const room = fieldValue(row.fields, fieldAliases.room) || '未识别房号';
  const phone = fieldValue(row.fields, fieldAliases.phone);
  const space = fieldValue(row.fields, fieldAliases.space);
  const expiry = fieldValue(row.fields, fieldAliases.expiry);
  const details = Object.entries(row.fields).filter(([, value]) => value !== null && String(value).trim() !== '').slice(0, 24);
  return (
    <article className="parking-query-card">
      <div className={`parking-license-plate ${plate.length > 7 ? 'is-green' : 'is-blue'}`}><span>{plate}</span></div>
      <div className="parking-query-primary">
        <strong><HomeOutlined /> {room}</strong>
        <span><UserOutlined /> {owner}</span>
      </div>
      <div className="parking-query-meta">
        {phone && <span><PhoneOutlined /> {phone}</span>}
        {space && <span><CarOutlined /> {space}</span>}
        {expiry && <span><CalendarOutlined /> 到期：{expiry}</span>}
      </div>
      <Tag color="blue">{row.database}</Tag>
      <details className="parking-query-details">
        <summary>查看旧库原始字段</summary>
        <dl>{details.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
      </details>
    </article>
  );
}
