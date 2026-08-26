import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tree,
  Typography,
} from 'antd';
import {
  ApartmentOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from '../lib/api';
import { handleGone } from '../lib/gone';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import PropertiesImportModal from './PropertiesImportModal';

const { Title, Text, Paragraph } = Typography;

interface Community {
  id: number;
  name: string;
  parentId?: number | null;
  /** true = 分组节点（如「枫桦景苑」），本身不挂房产 */
  isGroup?: boolean;
  address?: string | null;
  enabled?: boolean;
}
interface HouseRow {
  id: number;
  communityId: number;
  buildingId: number;
  unitId: number | null;
  roomNo: string;
  propertyType: string;
  roadName: string | null;
  fullAddress: string | null;
  shopName: string | null;
  areaSqm: string | null;
  lane: string | null;
  buildingNo: string;
  communityName: string;
  owner: { id: number; name: string | null; phone: string | null } | null;
}

// 业主档案只管普通小程序用户。保安/居委会/业委会/物业工作人员是「工作人员」，
// 在「用户管理」里登记（填同一手机号即可把已注册的小程序账号就地转过去），
// 那边配可代报小区与网页登录 —— 两页各管一类人，同一个人不会出现两条档案。

function formatLocation(h: { communityName: string; lane: string | null; buildingNo: string; roomNo: string }) {
  return `${h.communityName} · ${h.lane ? h.lane + ' 弄 ' : ''}${h.buildingNo} 号 ${h.roomNo} 室`;
}

/** 「枫桦景苑」+「枫桦景苑二期」→「二期」，避免上下级名字整段重复 */
function shortPhaseName(name: string, parentName?: string | null) {
  if (parentName && name.startsWith(parentName) && name.length > parentName.length) {
    return name.slice(parentName.length);
  }
  return name;
}

/** 楼栋节点：已经在分期下面了，主弄号就不用再重复写一遍 */
function formatBuildingNode(
  lane: string | null,
  buildingNo: string,
  roadName: string | null,
  mainLane: string | null,
) {
  if (lane && lane !== mainLane) return `${lane}弄${buildingNo}号`;
  if (!lane && roadName) return `${roadName}${buildingNo}号`;
  return `${buildingNo}号楼`;
}

function buildFullAddress(values: {
  roadName?: string;
  lane?: string;
  buildingNo?: string;
  roomNo?: string;
  propertyType?: string;
}) {
  const roadName = String(values.roadName || '').trim();
  const lane = String(values.lane || '').trim();
  const buildingNo = String(values.buildingNo || '').trim();
  const roomNo = String(values.roomNo || '').trim();
  if (!roadName || !buildingNo) return '';
  const roomSuffix = values.propertyType === '商铺'
    ? (roomNo && roomNo !== '商铺' ? `${roomNo}室` : '')
    : (roomNo ? `${roomNo}室` : '');
  return `${roadName}${lane ? `${lane}弄` : ''}${buildingNo}号${roomSuffix}`;
}

export default function PropertiesPage() {
  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>房产管理</Title>
      <Paragraph type="secondary" style={{ marginTop: -8 }}>
        业主档案已挪到 <Link to="/owners">「业主用户」</Link> 页 —— 业主端小程序的用户
        （档案、入驻审核、启停）都在那里；保安/居委会/业委会等走员工端，在「用户管理」。
      </Paragraph>
      <HousesTab />
    </div>
  );
}

// ====================================================================
// 房产 Tab
// ====================================================================
/** 左侧层级树选中的节点：小区(分组) → 分期 → 楼栋，房号是表格里的第四级 */
type TreeSelection =
  | { kind: 'all' }
  | { kind: 'group'; id: number }
  | { kind: 'community'; id: number }
  | { kind: 'building'; id: number };

function parseTreeKey(key: string): TreeSelection {
  const [kind, rawId] = key.split(':');
  const id = Number(rawId);
  if (kind === 'g') return { kind: 'group', id };
  if (kind === 'c') return { kind: 'community', id };
  if (kind === 'b') return { kind: 'building', id };
  return { kind: 'all' };
}

function HousesTab() {
  const { message, modal } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('properties');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [selection, setSelection] = useState<TreeSelection>({ kind: 'all' });
  const [rows, setRows] = useState<HouseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingHouse, setEditingHouse] = useState<HouseRow | null>(null);
  const [communityModalOpen, setCommunityModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const loadCommunities = useCallback(async () => {
    try {
      const list = await request<Community[]>({
        url: '/communities',
        query: { includeGroups: true },
      });
      setCommunities(list);
    } catch (e: any) { message.error(e?.message || '加载小区失败'); }
  }, [message]);

  // 一次拉全，左侧树和表格用同一份数据，保证角标数量和列表口径一致
  const loadHouses = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<HouseRow[]>({
        url: '/houses',
        query: { q: q || undefined },
      });
      setRows(list);
    } catch (e: any) {
      message.error(e?.message || '加载房产失败');
    } finally { setLoading(false); }
  }, [q, message]);

  useEffect(() => { loadCommunities(); }, [loadCommunities]);
  useEffect(() => { loadHouses(); }, [loadHouses]);

  const communityById = useMemo(
    () => new Map(communities.map((c) => [c.id, c])),
    [communities],
  );

  /** 小区(分组) → 分期 → 楼栋 三层树；每层带户数角标 */
  const treeData = useMemo(() => {
    const housesByCommunity = new Map<number, HouseRow[]>();
    for (const row of rows) {
      const list = housesByCommunity.get(row.communityId) ?? [];
      list.push(row);
      housesByCommunity.set(row.communityId, list);
    }

    const buildCommunityNode = (community: Community) => {
      const own = housesByCommunity.get(community.id) ?? [];
      const buildings = new Map<number, HouseRow[]>();
      for (const row of own) {
        const list = buildings.get(row.buildingId) ?? [];
        list.push(row);
        buildings.set(row.buildingId, list);
      }
      const parentName = community.parentId
        ? communityById.get(community.parentId)?.name
        : null;
      // 主弄号 = 覆盖户数最多的那个「弄」，楼栋节点里省掉它
      const laneWeight = new Map<string, number>();
      for (const row of own) {
        if (!row.lane) continue;
        laneWeight.set(row.lane, (laneWeight.get(row.lane) ?? 0) + 1);
      }
      const mainLane = Array.from(laneWeight.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        key: `c:${community.id}`,
        title: `${shortPhaseName(community.name, parentName)}${mainLane ? `（${mainLane}弄）` : ''} (${own.length})`,
        children: Array.from(buildings.entries()).map(([buildingId, list]) => ({
          key: `b:${buildingId}`,
          title: `${formatBuildingNode(list[0].lane, list[0].buildingNo, list[0].roadName, mainLane)} (${list.length})`,
          isLeaf: true,
        })),
      };
    };

    const groups = communities.filter((c) => c.isGroup);
    const groupedChildIds = new Set(
      communities.filter((c) => c.parentId).map((c) => c.id),
    );
    const nodes = [
      ...groups.map((group) => {
        const children = communities.filter((c) => c.parentId === group.id);
        const total = children.reduce(
          (sum, child) => sum + (housesByCommunity.get(child.id)?.length ?? 0),
          0,
        );
        return {
          key: `g:${group.id}`,
          title: `${group.name} (${total})`,
          children: children.map(buildCommunityNode),
        };
      }),
      ...communities
        .filter((c) => !c.isGroup && !groupedChildIds.has(c.id))
        .map(buildCommunityNode),
    ];
    return [
      { key: 'all', title: `全部 (${rows.length})`, isLeaf: true },
      ...nodes,
    ];
  }, [communities, communityById, rows]);

  const visibleRows = useMemo(() => {
    if (selection.kind === 'all') return rows;
    if (selection.kind === 'building') {
      return rows.filter((row) => row.buildingId === selection.id);
    }
    if (selection.kind === 'community') {
      return rows.filter((row) => row.communityId === selection.id);
    }
    const childIds = new Set(
      communities.filter((c) => c.parentId === selection.id).map((c) => c.id),
    );
    return rows.filter((row) => childIds.has(row.communityId));
  }, [rows, selection, communities]);

  /** 新增房产时默认带上当前选中的分期（分组节点不挂房产） */
  const defaultCommunityId =
    selection.kind === 'community'
      ? selection.id
      : selection.kind === 'building'
        ? visibleRows[0]?.communityId
        : undefined;

  const onDelete = (r: HouseRow) => {
    modal.confirm({
      title: `确认删除房产 ${formatLocation(r)} ?`,
      content: '删除后不可恢复，且会校验是否有业主或历史工单。',
      okType: 'danger',
      onOk: async () => {
        try {
          await request({ method: 'DELETE', url: `/houses/${r.id}` });
          message.success('已删除');
          loadHouses();
        } catch (e: any) {
          if (handleGone(e, message, '这套房产', loadHouses)) return;
          message.error(e?.message || '删除失败');
        }
      },
    });
  };

  return (
    <Row gutter={16}>
      <Col xs={24} md={6}>
        <Card
          size="small"
          title={<span><ApartmentOutlined /> 小区 · 分期 · 楼栋</span>}
          extra={
            <Button type="link" size="small" onClick={() => setCommunityModalOpen(true)}>
              管理
            </Button>
          }
          styles={{ body: { padding: 8, maxHeight: 560, overflowY: 'auto' } }}
        >
          {communities.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有小区" />
            : (
              <Tree
                blockNode
                treeData={treeData}
                selectedKeys={[
                  selection.kind === 'all'
                    ? 'all'
                    : `${selection.kind === 'group' ? 'g' : selection.kind === 'community' ? 'c' : 'b'}:${selection.id}`,
                ]}
                onSelect={(keys) => {
                  if (!keys.length) return;
                  setSelection(parseTreeKey(String(keys[0])));
                }}
              />
            )}
        </Card>
      </Col>

      <Col xs={24} md={18}>
        <Card
          title={(
            <span>
              房产列表{' '}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {visibleRows.length === rows.length
                  ? `共 ${rows.length} 户`
                  : `${visibleRows.length} 户 / 共 ${rows.length} 户`}
              </Text>
            </span>
          )}
          extra={
            <Space>
              <Input
                placeholder="搜索 弄/号/室/业主"
                prefix={<SearchOutlined />}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onPressEnter={loadHouses}
                allowClear
                style={{ width: 220 }}
              />
              <Button icon={<ReloadOutlined />} onClick={loadHouses}>刷新</Button>
              {canEdit && (
                <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>导入</Button>
              )}
              {canEdit && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setCreateOpen(true)}
                  disabled={communities.length === 0}
                >
                  新增房产
                </Button>
              )}
            </Space>
          }
        >
          <Table
            rowKey="id"
            size="middle"
            loading={loading}
            dataSource={visibleRows}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            columns={[
              {
                title: '小区', dataIndex: 'communityName', width: 170, fixed: 'left',
                render: (_, r) => {
                  const community = communityById.get(r.communityId);
                  const parentName = community?.parentId
                    ? communityById.get(community.parentId)?.name
                    : null;
                  if (!parentName) return r.communityName;
                  return (
                    <span>
                      {parentName}
                      <Text type="secondary"> / {shortPhaseName(r.communityName, parentName)}</Text>
                    </span>
                  );
                },
              },
              {
                title: '类型', dataIndex: 'propertyType', width: 90,
                render: (v) => v === '商铺' ? <Tag color="purple">商铺</Tag> : <Tag color="blue">{v || '住宅'}</Tag>,
              },
              { title: '路名', dataIndex: 'roadName', width: 100, render: (v) => v || '-' },
              { title: '弄', dataIndex: 'lane', width: 80, render: (v) => v || '-' },
              { title: '号', dataIndex: 'buildingNo', width: 80 },
              { title: '室', dataIndex: 'roomNo', width: 100 },
              { title: '完整地址', dataIndex: 'fullAddress', width: 220, ellipsis: true, render: (v) => v || '-' },
              { title: '商铺名称', dataIndex: 'shopName', width: 140, render: (v) => v || '-' },
              {
                title: '面积(m²)', dataIndex: 'areaSqm', width: 100,
                render: (v: string | null) => v ? Number(v).toFixed(2) : <Text type="secondary">-</Text>,
              },
              {
                title: '业主', key: 'owner', width: 180,
                render: (_, r) => r.owner
                  ? <span>{r.owner.name || '-'} <Text type="secondary" style={{ fontSize: 12 }}>{r.owner.phone}</Text></span>
                  : <Text type="secondary">未绑定</Text>,
              },
              {
                title: '操作', key: 'op', width: 130, fixed: 'right',
                render: (_, r) => (
                  <Space size="small">
                    {canEdit && (
                      <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditingHouse(r)}>编辑</Button>
                    )}
                    {canDelete && (
                      <Popconfirm title="确认删除？" onConfirm={() => onDelete(r)} okType="danger">
                        <Button type="link" size="small" danger>删除</Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
            scroll={{ x: 1420 }}
          />
        </Card>
      </Col>

      <HouseFormModal
        open={createOpen}
        communities={communities}
        defaultCommunityId={defaultCommunityId}
        onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); loadHouses(); }}
      />
      <HouseFormModal
        open={!!editingHouse}
        communities={communities}
        target={editingHouse || undefined}
        onClose={() => setEditingHouse(null)}
        onDone={() => { setEditingHouse(null); loadHouses(); }}
      />
      <CommunityManagerModal
        open={communityModalOpen}
        communities={communities}
        onClose={() => setCommunityModalOpen(false)}
        onChanged={() => { loadCommunities(); loadHouses(); }}
      />
      <PropertiesImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => { setImportOpen(false); loadCommunities(); loadHouses(); }}
      />
    </Row>
  );
}

// ============= 房产 新增 / 编辑 Modal =============
function HouseFormModal({
  open, communities, target, defaultCommunityId, onClose, onDone,
}: {
  open: boolean;
  communities: Community[];
  target?: HouseRow;
  defaultCommunityId?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [fullAddressTouched, setFullAddressTouched] = useState(false);

  const syncFullAddress = () => {
    if (fullAddressTouched) return;
    const next = buildFullAddress(form.getFieldsValue(['roadName', 'lane', 'buildingNo', 'roomNo', 'propertyType']));
    form.setFieldValue('fullAddress', next || undefined);
  };

  useEffect(() => {
    if (!open) return;
    setFullAddressTouched(false);
    if (target) {
      form.setFieldsValue({
        communityId: target.communityId,
        lane: target.lane || undefined,
        buildingNo: target.buildingNo,
        roomNo: target.roomNo,
        propertyType: target.propertyType || '住宅',
        roadName: target.roadName || undefined,
        fullAddress: target.fullAddress || undefined,
        shopName: target.shopName || undefined,
        areaSqm: target.areaSqm ? Number(target.areaSqm) : undefined,
      });
      setFullAddressTouched(!!target.fullAddress);
    } else {
      form.resetFields();
      form.setFieldsValue({ propertyType: '住宅' });
      if (defaultCommunityId) form.setFieldsValue({ communityId: defaultCommunityId });
    }
  }, [open, target, defaultCommunityId, form]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (target) {
        await request({
          method: 'PATCH',
          url: `/houses/${target.id}`,
          data: {
            roomNo: v.roomNo,
            propertyType: v.propertyType,
            roadName: v.roadName || undefined,
            fullAddress: v.fullAddress || undefined,
            shopName: v.shopName || undefined,
            areaSqm: v.areaSqm != null ? String(v.areaSqm) : undefined,
          },
        });
        message.success('已保存');
      } else {
        await request({
          method: 'POST',
          url: '/houses',
          data: {
            communityId: v.communityId,
            lane: v.lane || undefined,
            buildingNo: v.buildingNo,
            roomNo: v.roomNo,
            propertyType: v.propertyType,
            roadName: v.roadName || undefined,
            fullAddress: v.fullAddress || undefined,
            shopName: v.shopName || undefined,
            areaSqm: v.areaSqm != null ? String(v.areaSqm) : undefined,
          },
        });
        message.success('房产已新增');
      }
      onDone();
    } catch (e: any) {
      if (target && handleGone(e, message, '这套房产', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑房产 #${target.id}` : '新增房产'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        onValuesChange={(changed) => {
          if ('fullAddress' in changed) {
            setFullAddressTouched(true);
            return;
          }
          if (['roadName', 'lane', 'buildingNo', 'roomNo', 'propertyType'].some((key) => key in changed)) {
            setTimeout(syncFullAddress, 0);
          }
        }}
      >
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="propertyType" label="房产类型" initialValue="住宅">
              <Select
                options={[
                  { value: '住宅', label: '住宅' },
                  { value: '商铺', label: '商铺' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="roadName" label="路名">
              <Input placeholder="如：剑川路" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="communityId" label="小区 / 分期" rules={[{ required: true }]}>
          <Select
            placeholder="选择小区或分期"
            options={withOptionTitles(
              // 分组节点（如「枫桦景苑」）不挂房产，只有分期能选
              communities.filter((c) => !c.isGroup).map((c) => ({ value: c.id, label: c.name })),
            )}
            disabled={!!target}
            {...searchableWideSelectProps}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="lane" label="弄">
              <Input placeholder="如：1（无可留空）" disabled={!!target} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="buildingNo" label="号" rules={[{ required: true }]}>
              <Input placeholder="如：12" disabled={!!target} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="roomNo" label="室" rules={[{ required: true }]}>
              <Input placeholder="如：502" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="areaSqm" label="建筑面积 (㎡)">
          <InputNumber min={0} step={0.01} precision={2} style={{ width: '100%' }} placeholder="可选" />
        </Form.Item>
        <Form.Item name="fullAddress" label="完整地址">
          <Input
            placeholder="自动生成，可手动调整"
            addonAfter={
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setFullAddressTouched(false);
                  const next = buildFullAddress(form.getFieldsValue(['roadName', 'lane', 'buildingNo', 'roomNo', 'propertyType']));
                  form.setFieldValue('fullAddress', next || undefined);
                }}
              >
                重新生成
              </Button>
            }
          />
        </Form.Item>
        <Form.Item name="shopName" label="商铺名称">
          <Input placeholder="商铺可填写，住宅留空" />
        </Form.Item>
        {target && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            提示：小区/弄/号 不在此处修改。需要时去「管理小区」或新建房产并删除旧的。
          </Text>
        )}
      </Form>
    </Modal>
  );
}

// ============= 小区管理 Modal =============
function CommunityManagerModal({
  open, communities, onClose, onChanged,
}: {
  open: boolean;
  communities: Community[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('properties');
  const [form] = Form.useForm();
  const [editing, setEditing] = useState<Community | null>(null);
  const [saving, setSaving] = useState(false);
  const [grouping, setGrouping] = useState(false);

  const startEdit = (c: Community | null) => {
    setEditing(c);
    if (c) {
      form.setFieldsValue({ name: c.name, address: c.address, parentId: c.parentId ?? null });
    } else {
      form.resetFields();
    }
  };

  const onSubmit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await request({
          method: 'PATCH',
          url: `/communities/${editing.id}`,
          data: { name: v.name, address: v.address, parentId: v.parentId ?? null },
        });
        message.success('已保存');
      } else {
        await request({ method: 'POST', url: '/communities', data: v });
        message.success('小区已创建');
      }
      form.resetFields();
      setEditing(null);
      onChanged();
    } catch (e: any) {
      if (editing && handleGone(e, message, '这个小区', () => { setEditing(null); onChanged(); })) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onAutoGroup = () => {
    modal.confirm({
      title: '按「N 期」自动归组？',
      content: '会把「枫桦景苑一期 / 二期」这类同前缀的小区挂到上级「枫桦景苑」下面，不改动任何房产数据。重复执行不会有副作用。',
      onOk: async () => {
        setGrouping(true);
        try {
          const r = await request<{ createdGroups: number; linked: number; skipped: string[] }>({
            method: 'POST',
            url: '/communities/auto-group',
            data: {},
          });
          message.success(
            r.linked
              ? `已归组：新建上级 ${r.createdGroups} 个，挂上 ${r.linked} 个分期`
              : '没有需要归组的小区',
          );
          if (r.skipped?.length) {
            message.warning(`「${r.skipped.join('、')}」自己还挂着房产，没有当成上级`);
          }
          onChanged();
        } catch (e: any) {
          message.error(e?.message || '归组失败');
        } finally { setGrouping(false); }
      },
    });
  };

  /** 可作为上级的：本身没有上级的小区（层级最多两层），且不能是自己 */
  const parentOptions = communities
    .filter((c) => !c.parentId && c.id !== editing?.id)
    .map((c) => ({ value: c.id, label: c.name }));

  const onDelete = (c: Community) => {
    modal.confirm({
      title: `确认删除小区「${c.name}」?`,
      content: '小区下若有楼栋/房产将无法删除。',
      okType: 'danger',
      onOk: async () => {
        try {
          await request({ method: 'DELETE', url: `/communities/${c.id}` });
          message.success('已删除');
          onChanged();
        } catch (e: any) {
          if (handleGone(e, message, '这个小区', onChanged)) return;
          message.error(e?.message || '删除失败');
        }
      },
    });
  };

  return (
    <Modal
      title={(
        <Space size={12}>
          <span>小区管理</span>
          {canEdit && (
            <Button size="small" loading={grouping} onClick={onAutoGroup}>按「N 期」自动归组</Button>
          )}
        </Space>
      )}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={760}
    >
      <Row gutter={16}>
        <Col span={canEdit ? 14 : 24}>
          <Table
            rowKey="id"
            size="small"
            dataSource={communities}
            pagination={false}
            columns={[
              {
                title: '名称', dataIndex: 'name',
                render: (v, r) => (
                  <span>
                    {v}
                    {r.isGroup && <Tag color="blue" style={{ marginLeft: 6 }}>上级</Tag>}
                  </span>
                ),
              },
              {
                title: '上级小区', dataIndex: 'parentId', width: 120,
                render: (v: number | null | undefined) => {
                  const parent = communities.find((c) => c.id === v);
                  return parent ? parent.name : <Text type="secondary">-</Text>;
                },
              },
              {
                title: '地址', dataIndex: 'address', ellipsis: true,
                render: (v) => v || <Text type="secondary">-</Text>,
              },
              {
                title: '操作', key: 'op', width: 100,
                render: (_, r) => (
                  <Space size="small">
                    {canEdit && (
                      <Button type="link" size="small" onClick={() => startEdit(r)}>改</Button>
                    )}
                    {canDelete && (
                      <Popconfirm title="确认删除？" onConfirm={() => onDelete(r)} okType="danger">
                        <Button type="link" size="small" danger>删</Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Col>
        {canEdit && (
        <Col span={10}>
          <Card size="small" title={editing ? `编辑「${editing.name}」` : '新建小区'}>
            <Form form={form} layout="vertical">
              <Form.Item name="name" label="小区名称" rules={[{ required: true }]}>
                <Input placeholder="如：阳光花园" />
              </Form.Item>
              <Form.Item
                name="parentId"
                label="上级小区"
                extra="分期填上级，如「枫桦景苑一期」的上级是「枫桦景苑」；不分期就留空"
              >
                <Select
                  allowClear
                  placeholder="不挂上级"
                  options={withOptionTitles(parentOptions)}
                  {...searchableWideSelectProps}
                />
              </Form.Item>
              <Form.Item name="address" label="地址">
                <Input placeholder="如：松江区 XX 路 100 号" />
              </Form.Item>
              <Space>
                <Button type="primary" loading={saving} onClick={onSubmit}>
                  {editing ? '保存' : '新建'}
                </Button>
                {editing && <Button onClick={() => { setEditing(null); form.resetFields(); }}>取消</Button>}
              </Space>
            </Form>
          </Card>
        </Col>
        )}
      </Row>
    </Modal>
  );
}
