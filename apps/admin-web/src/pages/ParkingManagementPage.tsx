import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  DatabaseOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { accessCardIssuance, type AccessCardReadiness } from '@pms/api-client';
import { useCallback, useEffect, useState } from 'react';
import './ParkingManagementPage.css';

const { Text, Title } = Typography;

export default function ParkingManagementPage() {
  const { message } = AntdApp.useApp();
  const [readiness, setReadiness] = useState<AccessCardReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [gatewayName, setGatewayName] = useState('枫桦景苑停车系统网关');
  const [enrolling, setEnrolling] = useState(false);
  const [credential, setCredential] = useState<{ id: string; token: string; message: string } | null>(null);

  const loadReadiness = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await accessCardIssuance.readiness());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停车网关状态加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void loadReadiness(); }, [loadReadiness]);

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

  const gateway = readiness?.agents.find((item) => item.kind === 'parking_gateway');
  const online = gateway?.status === 'online';
  const canRead = online && readiness?.features.parkingDbRead === true;

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
        type={canRead ? 'info' : 'warning'}
        showIcon
        message={canRead ? '停车数据库只读连接已就绪' : '尚未接通真实停车数据'}
        description={canRead
          ? '网关已上报只读能力；住户、车辆和续期查询接口完成验收后才会在此开放。'
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
            <Tag color={canRead ? 'blue' : 'default'}>{canRead ? '只读已就绪' : '尚未验证'}</Tag>
            <Tag>写入未开放</Tag>
          </div>
        </div>
      </Card>

      <Card className="parking-resident-card parking-live-search" variant="borderless">
        <div className="parking-resident-search">
          <div>
            <span className="parking-section-kicker">真实数据查询</span>
            <Title level={3}>查找房号、住户或车牌</Title>
            <Text type="secondary">只有经过验收的真实查询接口才会开放输入。</Text>
          </div>
          <Input disabled prefix={<SearchOutlined />} placeholder="真实停车数据接口尚未启用" aria-label="停车数据查询尚未启用" />
        </div>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={online ? '网关已连接，等待真实查询接口验收' : '未连接真实停车数据库，不显示模拟数据'}
        />
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
