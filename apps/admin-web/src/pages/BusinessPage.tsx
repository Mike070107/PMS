import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CarOutlined,
  CreditCardOutlined,
  FileDoneOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import { useAuth, usePagePerm } from '../lib/auth';
import { nameOr } from '../lib/displayName';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

const { Title, Text } = Typography;

type ServiceType = 'parking_monthly' | 'access_card';
type BillingUnit = 'month' | 'card';

interface BusinessRule {
  id: number;
  serviceType: ServiceType;
  name: string;
  /** null = 公司通用；否则只适用于该小区 */
  communityId: number | null;
  billingUnit: BillingUnit;
  unitPriceCents: number;
  enabled: boolean;
}

interface CommunityOption {
  id: number;
  name: string;
}

interface HouseHit {
  id: number;
  roomNo: string;
  lane: string | null;
  buildingNo: string;
  communityId: number | null;
  communityName: string;
  owner: { id: number; name: string | null; phone: string | null } | null;
}

interface Vehicle {
  id: number;
  plateNo: string;
  houseId: number;
  ownerId: number | null;
  validUntil: string | null;
}

interface AccessCard {
  id: number;
  cardNo: string;
  houseId: number;
  ownerId: number | null;
  status: string;
}

interface BusinessSearchResult {
  houses: HouseHit[];
  vehicles: Vehicle[];
  accessCards: AccessCard[];
}

interface EstimateResult {
  unitPriceCents: number;
  quantity: number;
  startDate: string | null;
  endDate: string | null;
  amountCents: number;
  summary: string;
}

interface BusinessTransaction {
  id: number;
  txnNo: string;
  serviceType: ServiceType;
  amountCents: number;
  quantity: number;
  paymentMethod: string | null;
  externalSyncStatus: string;
  invoiceStatus: string;
  createdAt: string;
}

function money(cents?: number | null) {
  return `¥${((cents || 0) / 100).toFixed(2)}`;
}

function houseLabel(h: HouseHit) {
  return `${h.communityName} · ${h.lane ? `${h.lane}弄` : ''}${h.buildingNo}号 ${h.roomNo}室`;
}

export default function BusinessPage() {
  const [tab, setTab] = useState<ServiceType>('parking_monthly');

  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text className="pms-page-note" type="secondary">按房号、业主、手机号或车牌查询后办理收费业务，收费规则支持全公司通用或按小区单独定价。</Text>
      </Space>
      <Tabs
        activeKey={tab}
        onChange={(v) => setTab(v as ServiceType)}
        items={[
          {
            key: 'parking_monthly',
            label: <span><CarOutlined /> 停车月租</span>,
            children: <BusinessFlow serviceType="parking_monthly" />,
          },
          {
            key: 'access_card',
            label: <span><CreditCardOutlined /> 门禁卡</span>,
            children: <BusinessFlow serviceType="access_card" />,
          },
          {
            key: 'rules',
            label: <span><SettingOutlined /> 收费规则</span>,
            children: <RulesPanel />,
          },
        ]}
      />
    </div>
  );
}

function BusinessFlow({ serviceType }: { serviceType: ServiceType }) {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('business');
  const [form] = Form.useForm();
  const [q, setQ] = useState('');
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [result, setResult] = useState<BusinessSearchResult>({ houses: [], vehicles: [], accessCards: [] });
  const [selectedHouse, setSelectedHouse] = useState<HouseHit | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [transactions, setTransactions] = useState<BusinessTransaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 选中房号后只留「公司通用 + 该房号所在小区」的规则，跨小区的规则后端也会拦
  const activeRules = useMemo(
    () =>
      rules.filter(
        (r) =>
          r.serviceType === serviceType &&
          r.enabled &&
          (r.communityId == null ||
            !selectedHouse ||
            r.communityId === selectedHouse.communityId),
      ),
    [rules, serviceType, selectedHouse],
  );

  const loadRules = useCallback(async () => {
    setRules(await request<BusinessRule[]>({ url: '/business/rules' }));
  }, []);

  const loadTransactions = useCallback(async () => {
    setTransactions(await request<BusinessTransaction[]>({ url: '/business/transactions' }));
  }, []);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<BusinessSearchResult>({
        url: '/business/search',
        query: { q: q || undefined, serviceType },
      });
      setResult(data);
      setEstimate(null);
    } catch (e: any) {
      message.error(e?.message || '查询失败');
    } finally {
      setLoading(false);
    }
  }, [message, q, serviceType]);

  useEffect(() => {
    loadRules().catch((e) => message.error(e?.message || '加载规则失败'));
    loadTransactions().catch(() => undefined);
  }, [loadRules, loadTransactions, message]);

  useEffect(() => {
    form.resetFields();
    setSelectedHouse(null);
    setSelectedVehicle(null);
    setEstimate(null);
  }, [form, serviceType]);

  useEffect(() => {
    // 换了房号后原先选的规则可能不再适用（属于别的小区），自动落回第一条可用规则
    const current = form.getFieldValue('ruleId');
    if (current && activeRules.some((r) => r.id === current)) return;
    if (activeRules.length > 0) {
      form.setFieldsValue({ ruleId: activeRules[0].id });
    }
  }, [activeRules, form]);

  const applyHouse = (h: HouseHit) => {
    setSelectedHouse(h);
    setSelectedVehicle(null);
    form.setFieldsValue({
      houseId: h.id,
      ownerId: h.owner?.id,
      plateNo: undefined,
    });
    setEstimate(null);
  };

  const applyVehicle = (v: Vehicle) => {
    setSelectedVehicle(v);
    form.setFieldsValue({
      vehicleId: v.id,
      houseId: v.houseId,
      ownerId: v.ownerId ?? undefined,
      plateNo: v.plateNo,
    });
    const h = result.houses.find((item) => item.id === v.houseId);
    if (h) setSelectedHouse(h);
    setEstimate(null);
  };

  const doEstimate = async () => {
    const values = await form.validateFields();
    try {
      const payload = buildPayload(serviceType, values, selectedHouse, selectedVehicle);
      const data = await request<EstimateResult>({
        method: 'POST',
        url: '/business/estimate',
        data: payload,
      });
      setEstimate(data);
    } catch (e: any) {
      message.error(e?.message || '试算失败');
    }
  };

  const complete = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = buildPayload(serviceType, values, selectedHouse, selectedVehicle);
      await request({
        method: 'POST',
        url: '/business/complete',
        data: { ...payload, paymentMethod: values.paymentMethod, remark: values.remark },
      });
      message.success('业务已办理，已记录收费、外部系统同步占位和发票占位日志');
      form.setFieldsValue({ plateNo: undefined, remark: undefined });
      setEstimate(null);
      setSelectedVehicle(null);
      await Promise.all([search(), loadTransactions()]);
    } catch (e: any) {
      message.error(e?.message || '办理失败');
    } finally {
      setSaving(false);
    }
  };

  const isParking = serviceType === 'parking_monthly';

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={15}>
        <Card
          title={isParking ? '停车费月租办理' : '门禁卡购买 / 补卡'}
          extra={
            <Space>
              <Input
                placeholder={isParking ? '输入房号 / 业主 / 手机号 / 车牌' : '输入房号 / 业主 / 手机号'}
                prefix={<SearchOutlined />}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onPressEnter={search}
                allowClear
                style={{ width: 280 }}
              />
              <Button icon={<SearchOutlined />} loading={loading} onClick={search}>查询</Button>
            </Space>
          }
        >
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Table
                rowKey="id"
                size="small"
                title={() => '房号 / 业主'}
                loading={loading}
                dataSource={result.houses}
                pagination={{ pageSize: 5 }}
                columns={[
                  {
                    title: '房号',
                    render: (_, r) => (
                      <Button type="link" size="small" onClick={() => applyHouse(r)}>
                        {houseLabel(r)}
                      </Button>
                    ),
                  },
                  {
                    title: '业主',
                    width: 150,
                    render: (_, r) => r.owner ? `${r.owner.name || '-'} ${r.owner.phone || ''}` : <Text type="secondary">未绑定</Text>,
                  },
                ]}
              />
            </Col>
            <Col xs={24} lg={12}>
              {isParking ? (
                <Table
                  rowKey="id"
                  size="small"
                  title={() => '车辆清单'}
                  dataSource={result.vehicles}
                  pagination={{ pageSize: 5 }}
                  columns={[
                    {
                      title: '车牌',
                      render: (_, r) => <Button type="link" size="small" onClick={() => applyVehicle(r)}>{r.plateNo}</Button>,
                    },
                    { title: '有效期', dataIndex: 'validUntil', width: 120, render: (v) => v || '-' },
                  ]}
                />
              ) : (
                <Table
                  rowKey="id"
                  size="small"
                  title={() => '已有门禁卡'}
                  dataSource={result.accessCards.filter((c) => !selectedHouse || c.houseId === selectedHouse.id)}
                  pagination={{ pageSize: 5 }}
                  columns={[
                    { title: '卡号', dataIndex: 'cardNo' },
                    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'active' ? 'green' : 'default'}>{v}</Tag> },
                  ]}
                />
              )}
            </Col>
          </Row>

          <Card size="small" style={{ marginTop: 16 }} title="办理信息">
            <Form
              form={form}
              layout="vertical"
              initialValues={{ months: 1, quantity: 1, paymentMethod: 'cash' }}
            >
              <Row gutter={12}>
                <Col xs={24} md={8}>
                  <Form.Item name="ruleId" label="收费规则" rules={[{ required: true }]}>
                    <Select
                      placeholder="选择收费规则"
                      options={withOptionTitles(activeRules.map((r) => ({
                        value: r.id,
                        label: `${r.name} ${money(r.unitPriceCents)}/${r.billingUnit === 'month' ? '月' : '张'}`,
                      })))}
                      {...searchableWideSelectProps}
                    />
                  </Form.Item>
                </Col>
                {isParking ? (
                  <>
                    <Col xs={24} md={8}>
                      <Form.Item name="plateNo" label="车牌号" rules={[{ required: true, message: '请输入车牌号' }]}>
                        <Input placeholder="如：沪A12345" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item name="months" label="缴费月数" rules={[{ required: true }]}>
                        <InputNumber min={1} max={60} style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                  </>
                ) : (
                  <Col xs={24} md={8}>
                    <Form.Item name="quantity" label="购买张数" rules={[{ required: true }]}>
                      <InputNumber min={1} max={20} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                )}
                {isParking && (
                  <Col xs={24} md={8}>
                    <Form.Item name="endDate" label="或指定缴至日期">
                      <DatePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                )}
                <Col xs={24} md={8}>
                  <Form.Item name="paymentMethod" label="收款方式">
                    <Select
                      options={[
                        { value: 'cash', label: '现金' },
                        { value: 'wechat', label: '微信' },
                        { value: 'alipay', label: '支付宝' },
                        { value: 'bank', label: '转账' },
                        { value: 'other', label: '其他' },
                      ]}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24}>
                  <Form.Item name="remark" label="备注">
                    <Input.TextArea rows={2} placeholder="可填写收据号、特殊说明等" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>

            <Space wrap>
              <Tag color={selectedHouse ? 'blue' : 'default'}>
                {selectedHouse ? `已选：${houseLabel(selectedHouse)}` : '未选择房号'}
              </Tag>
              {selectedHouse?.owner && <Tag>{selectedHouse.owner.name || selectedHouse.owner.phone}</Tag>}
              {selectedVehicle && <Tag color="cyan">车辆：{selectedVehicle.plateNo}</Tag>}
            </Space>

            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col xs={24} md={8}>
                <Statistic title="试算金额" value={estimate ? money(estimate.amountCents) : '-'} />
              </Col>
              <Col xs={24} md={8}>
                <Statistic title="数量" value={estimate?.summary || '-'} />
              </Col>
              <Col xs={24} md={8}>
                <Statistic title="生效/到期" value={estimate?.endDate ? `${estimate.startDate} 至 ${estimate.endDate}` : '-'} />
              </Col>
            </Row>

            <Space style={{ marginTop: 16 }}>
              <Button icon={<FileDoneOutlined />} onClick={doEstimate}>试算金额</Button>
              {canEdit && (
                <Button type="primary" loading={saving} disabled={!estimate} onClick={complete}>
                  确认收费并完成办理
                </Button>
              )}
            </Space>
          </Card>
        </Card>
      </Col>

      <Col xs={24} xl={9}>
        <Card
          title="最近办理"
          extra={<Button icon={<ReloadOutlined />} onClick={loadTransactions}>刷新</Button>}
        >
          <Table
            rowKey="id"
            size="small"
            dataSource={transactions.filter((t) => t.serviceType === serviceType).slice(0, 8)}
            pagination={false}
            columns={[
              { title: '单号', dataIndex: 'txnNo', ellipsis: true },
              { title: '金额', dataIndex: 'amountCents', width: 90, render: money },
              { title: '联动', dataIndex: 'externalSyncStatus', width: 90, render: (v) => <Tag color="blue">{v}</Tag> },
              { title: '发票', dataIndex: 'invoiceStatus', width: 80, render: (v) => <Tag>{v}</Tag> },
            ]}
          />
        </Card>
      </Col>
    </Row>
  );
}

function buildPayload(
  serviceType: ServiceType,
  values: any,
  selectedHouse: HouseHit | null,
  selectedVehicle: Vehicle | null,
) {
  const endDate = values.endDate ? dayjs(values.endDate).format('YYYY-MM-DD') : undefined;
  return {
    serviceType,
    ruleId: values.ruleId,
    houseId: values.houseId ?? selectedHouse?.id,
    ownerId: values.ownerId ?? selectedHouse?.owner?.id,
    vehicleId: values.vehicleId ?? selectedVehicle?.id,
    plateNo: values.plateNo ? String(values.plateNo).trim().toUpperCase() : undefined,
    months: values.months,
    quantity: values.quantity,
    endDate,
  };
}

function RulesPanel() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('business');
  const { access } = useAuth();
  // 全公司范围才允许建「全部小区」通用规则；受限角色必须绑定自己范围内的小区
  const scopeAll = !access || access.scopeAll;
  const [form] = Form.useForm();
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [communities, setCommunities] = useState<CommunityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const communityName = useCallback(
    (id: number | null) =>
      id == null ? '全部小区' : nameOr(communities.find((c) => c.id === id)?.name, '小区'),
    [communities],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await request<BusinessRule[]>({ url: '/business/rules' }));
    } catch (e: any) {
      message.error(e?.message || '加载规则失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // 小区选项走 /communities，后端已按角色范围过滤
    request<CommunityOption[]>({ url: '/communities' })
      .then(setCommunities)
      .catch(() => undefined);
  }, []);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const isParking = v.serviceType === 'parking_monthly';
      await request({
        method: 'POST',
        url: '/business/rules',
        data: {
          serviceType: v.serviceType,
          name: v.name,
          communityId: v.communityId === 0 || v.communityId == null ? null : v.communityId,
          billingUnit: isParking ? 'month' : 'card',
          unitPriceCents: Math.round(Number(v.priceYuan) * 100),
          enabled: true,
        },
      });
      message.success('规则已新增');
      form.resetFields();
      load();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={16}>
        <Card title="收费规则列表">
          <Table
            rowKey="id"
            loading={loading}
            dataSource={rules}
            columns={[
              {
                title: '业务',
                dataIndex: 'serviceType',
                width: 140,
                render: (v: ServiceType) => v === 'parking_monthly' ? '停车月租' : '门禁卡',
              },
              { title: '规则名称', dataIndex: 'name' },
              {
                title: '适用小区',
                dataIndex: 'communityId',
                width: 150,
                render: (v: number | null) =>
                  v == null ? <Tag>全部小区</Tag> : communityName(v),
              },
              {
                title: '单价',
                width: 140,
                render: (_, r) => `${money(r.unitPriceCents)} / ${r.billingUnit === 'month' ? '月' : '张'}`,
              },
              {
                title: '状态',
                dataIndex: 'enabled',
                width: 90,
                render: (v) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
              },
            ]}
          />
        </Card>
      </Col>
      {canEdit && (
        <Col xs={24} lg={8}>
          <Card title="新增规则">
            <Form form={form} layout="vertical" initialValues={{ serviceType: 'parking_monthly' }}>
              <Form.Item name="serviceType" label="业务类型" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'parking_monthly', label: '停车月租' },
                    { value: 'access_card', label: '门禁卡' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="name" label="规则名称" rules={[{ required: true }]}>
                <Input placeholder="如：地面车位月租" />
              </Form.Item>
              <Form.Item
                name="communityId"
                label="适用小区"
                rules={[{ required: !scopeAll, message: '请选择适用小区' }]}
                extra={scopeAll
                  ? '不选 = 全部小区通用；各小区价格不同时按小区分别建规则。'
                  : '受限角色只能维护自己管理范围内小区的规则。'}
              >
                <Select
                  allowClear={scopeAll}
                  placeholder={scopeAll ? '全部小区（通用）' : '选择小区'}
                  options={withOptionTitles(
                    communities.map((c) => ({ value: c.id, label: c.name })),
                  )}
                  {...searchableWideSelectProps}
                />
              </Form.Item>
              <Form.Item name="priceYuan" label="单价（元）" rules={[{ required: true }]}>
                <InputNumber min={0} precision={2} style={{ width: '100%' }} />
              </Form.Item>
              <Button type="primary" loading={saving} onClick={save}>保存规则</Button>
            </Form>
          </Card>
        </Col>
      )}
    </Row>
  );
}
