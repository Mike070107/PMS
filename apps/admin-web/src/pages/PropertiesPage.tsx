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
  Switch,
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
  /** 所属管理处。只有顶层小区自己挂，分期由后端按上级回填 */
  officeId?: number | null;
  officeName?: string | null;
  address?: string | null;
  enabled?: boolean;
}
/** GET /houses/summary：树的户数角标 + 楼栋节点标题所需的最小信息 */
interface HouseSummary {
  total: number;
  communities: Array<{ communityId: number; count: number }>;
  buildings: Array<{
    buildingId: number;
    communityId: number;
    lane: string | null;
    buildingNo: string;
    roadName: string | null;
    count: number;
  }>;
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
      <Paragraph className="pms-page-note" type="secondary">
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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [summary, setSummary] = useState<HouseSummary>({ total: 0, communities: [], buildings: [] });
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingHouse, setEditingHouse] = useState<HouseRow | null>(null);
  const [communityModalOpen, setCommunityModalOpen] = useState(false);
  const [spotModalOpen, setSpotModalOpen] = useState(false);
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

  /**
   * 表格走服务端分页、树的角标走 /houses/summary。
   *
   * 原来是「一次拉全，树和表共用一份数据」——房产到 5000 套就顶到接口上限，
   * 树上写「全部 (5000)」、后面的房子直接看不见，还看不出是被截断的
   * （2026-08-27 导完永德片区 5013 套就撞上了）。现在两边各查各的，
   * 但过滤条件（scope、搜索词）保持同一套，角标和列表才对得上。
   */
  const houseQuery = useCallback(() => {
    const base: Record<string, unknown> = { q: q || undefined };
    if (selection.kind === 'building') base.buildingId = selection.id;
    // 分组节点（如「永南永北」）本身不挂房产，后端会自动展开到它下面的分期
    else if (selection.kind === 'community' || selection.kind === 'group') base.communityId = selection.id;
    return base;
  }, [q, selection]);

  const loadHouses = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<{ rows: HouseRow[]; total: number }>({
        url: '/houses',
        query: { ...houseQuery(), page, pageSize },
      });
      setRows(data.rows);
      setTotal(data.total);
    } catch (e: any) {
      message.error(e?.message || '加载房产失败');
    } finally { setLoading(false); }
  }, [houseQuery, page, pageSize, message]);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await request<HouseSummary>({ url: '/houses/summary', query: { q: q || undefined } }));
    } catch (e: any) {
      message.error(e?.message || '加载房产统计失败');
    }
  }, [q, message]);

  useEffect(() => { loadCommunities(); }, [loadCommunities]);
  useEffect(() => { loadHouses(); }, [loadHouses]);
  useEffect(() => { loadSummary(); }, [loadSummary]);
  // 换了节点或搜索词就回到第一页，否则会停在一个空白页上
  useEffect(() => { setPage(1); }, [selection, q]);

  const reloadAll = useCallback(() => { loadHouses(); loadSummary(); }, [loadHouses, loadSummary]);

  const communityById = useMemo(
    () => new Map(communities.map((c) => [c.id, c])),
    [communities],
  );

  /** 小区(分组) → 分期 → 楼栋 三层树；每层带户数角标（数字来自 /houses/summary，不受分页影响） */
  const treeData = useMemo(() => {
    const countByCommunity = new Map(summary.communities.map((c) => [c.communityId, c.count]));
    const buildingsByCommunity = new Map<number, HouseSummary['buildings']>();
    for (const b of summary.buildings) {
      const list = buildingsByCommunity.get(b.communityId) ?? [];
      list.push(b);
      buildingsByCommunity.set(b.communityId, list);
    }

    const buildCommunityNode = (community: Community) => {
      const own = buildingsByCommunity.get(community.id) ?? [];
      const parentName = community.parentId
        ? communityById.get(community.parentId)?.name
        : null;
      // 主弄号 = 覆盖户数最多的那个「弄」，楼栋节点里省掉它
      const laneWeight = new Map<string, number>();
      for (const b of own) {
        if (!b.lane) continue;
        laneWeight.set(b.lane, (laneWeight.get(b.lane) ?? 0) + b.count);
      }
      const mainLane = Array.from(laneWeight.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const houseCount = countByCommunity.get(community.id) ?? 0;
      return {
        key: `c:${community.id}`,
        houseCount,
        title: `${shortPhaseName(community.name, parentName)}${mainLane ? `（${mainLane}弄）` : ''} (${houseCount})`,
        children: own.map((b) => ({
          key: `b:${b.buildingId}`,
          title: `${formatBuildingNode(b.lane, b.buildingNo, b.roadName, mainLane)} (${b.count})`,
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
        const groupTotal = children.reduce(
          (sum, child) => sum + (countByCommunity.get(child.id) ?? 0),
          0,
        );
        return {
          key: `g:${group.id}`,
          houseCount: groupTotal,
          title: `${group.name} (${groupTotal})`,
          children: children.map(buildCommunityNode),
        };
      }),
      ...communities
        .filter((c) => !c.isGroup && !groupedChildIds.has(c.id))
        .map(buildCommunityNode),
    ];

    /**
     * 管理处这一层是**只读分组**，节点数据来自 communities.office_id，
     * 不在 communities 表里建对应的行 —— 2026-08-29 之前线上就是给每个管理处
     * 建了个同名顶层小区当分组，结果真小区被挤到「分期」那一层去了。
     * 管理处归属在「管理处」页面或小区管理的「所属管理处」里改，树上不能点改。
     */
    const officeOf = (node: { key: string }) => {
      const id = Number(node.key.split(':')[1]);
      const community = communityById.get(id);
      if (!community) return null;
      const owner = community.parentId ? communityById.get(community.parentId) : community;
      return owner?.officeName ?? null;
    };
    const byOffice = new Map<string, typeof nodes>();
    const loose: typeof nodes = [];
    for (const node of nodes) {
      const name = officeOf(node);
      if (!name) { loose.push(node); continue; }
      const list = byOffice.get(name) ?? [];
      list.push(node);
      byOffice.set(name, list);
    }
    const grouped = byOffice.size
      ? [...byOffice.entries()].map(([name, children]) => ({
          key: `o:${name}`,
          houseCount: children.reduce((sum, n) => sum + n.houseCount, 0),
          title: `${name} (${children.reduce((sum, n) => sum + n.houseCount, 0)})`,
          // 管理处只是分组，本身不是可筛选的实体；要按管理处看全部数据用顶栏的管理处切换器
          selectable: false,
          children,
        }))
      : [];

    return [
      { key: 'all', title: `全部 (${summary.total})`, isLeaf: true },
      ...grouped,
      ...(byOffice.size ? loose : nodes),
    ];
  }, [communities, communityById, summary]);

  /** 新增房产时默认带上当前选中的分期（分组节点不挂房产） */
  const defaultCommunityId =
    selection.kind === 'community'
      ? selection.id
      : selection.kind === 'building'
        ? rows[0]?.communityId
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
          reloadAll();
        } catch (e: any) {
          if (handleGone(e, message, '这套房产', reloadAll)) return;
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
          title={<span><ApartmentOutlined /> 管理处 · 小区 · 楼栋</span>}
          extra={
            <Space size={0}>
              <Button type="link" size="small" onClick={() => setCommunityModalOpen(true)}>
                管理
              </Button>
              {/* 监控室、水泵房这些地方没有房号，登记在这里，报修描述里说到就能认出来 */}
              <Button type="link" size="small" onClick={() => setSpotModalOpen(true)}>
                公区点位
              </Button>
            </Space>
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
                {q ? `搜到 ${total} 户` : `共 ${total} 户`}
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
                onPressEnter={reloadAll}
                allowClear
                style={{ width: 220 }}
              />
              <Button icon={<ReloadOutlined />} onClick={reloadAll}>刷新</Button>
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
            dataSource={rows}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: [20, 50, 100, 200],
              showTotal: (t) => `共 ${t} 户`,
              onChange: (p, ps) => { setPage(p); setPageSize(ps); },
            }}
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
        onDone={() => { setCreateOpen(false); reloadAll(); }}
      />
      <HouseFormModal
        open={!!editingHouse}
        communities={communities}
        target={editingHouse || undefined}
        onClose={() => setEditingHouse(null)}
        onDone={() => { setEditingHouse(null); reloadAll(); }}
      />
      <CommunityManagerModal
        open={communityModalOpen}
        communities={communities}
        onClose={() => setCommunityModalOpen(false)}
        onChanged={() => { loadCommunities(); reloadAll(); }}
      />
      <CommunitySpotsModal
        open={spotModalOpen}
        communities={communities}
        defaultCommunityId={defaultCommunityId}
        onClose={() => setSpotModalOpen(false)}
      />
      <PropertiesImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => { setImportOpen(false); loadCommunities(); reloadAll(); }}
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
  const [quickAddress, setQuickAddress] = useState('');
  const [parsing, setParsing] = useState(false);

  /**
   * 一句话地址 → 逐个字段。解析在服务端，和小程序语音报修**共用同一套**
   * （repair-address.util + 撞库），不会出现「小程序认得出、后台认不出」。
   * 只填认出来的那几项，认不出的保持原样让人自己填 —— 不猜、不清空已填的。
   */
  const parseQuickAddress = async () => {
    const text = quickAddress.trim();
    if (!text) return;
    setParsing(true);
    try {
      const r = await request<{
        matched: boolean;
        roadName?: string | null;
        communityId?: number | null;
        communityName?: string | null;
        lane?: string | null;
        buildingNo?: string | null;
        roomNo?: string | null;
        ambiguous?: string[];
      }>({ method: 'POST', url: '/houses/parse-address', data: { text } });
      if (!r.matched) {
        message.warning('没认出地址，按「弄 / 号 / 室」的写法再试，或直接逐项填');
        return;
      }
      const patch: Record<string, unknown> = {};
      if (r.roadName) patch.roadName = r.roadName;
      if (r.communityId) patch.communityId = r.communityId;
      if (r.lane) patch.lane = r.lane;
      if (r.buildingNo) patch.buildingNo = r.buildingNo;
      if (r.roomNo) patch.roomNo = r.roomNo;
      form.setFieldsValue(patch);
      setTimeout(syncFullAddress, 0);
      const filled = [
        r.roadName && `路名 ${r.roadName}`,
        r.communityName && `小区 ${r.communityName}`,
        r.lane && `${r.lane} 弄`,
        r.buildingNo && `${r.buildingNo} 号`,
        r.roomNo && `${r.roomNo} 室`,
      ].filter(Boolean).join('、');
      message.success(`已填：${filled || '（没认出可填的字段）'}`);
      // 认出一堆小区 = 等于没认出，明说是哪几个，让人自己选
      if (r.ambiguous?.length) {
        message.warning(`这个地址在 ${r.ambiguous.join('、')} 都有，小区请自己选`);
      } else if (!r.communityId) {
        message.warning('没认出是哪个小区，请自己选');
      }
    } catch (e: any) {
      message.error(e?.message || '解析失败');
    } finally {
      setParsing(false);
    }
  };

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
      title={target ? `编辑房产：${formatLocation(target)}` : '新增房产'}
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
        {/* 录入提速：整句地址粘进来一次填好，逐项填照旧可用。
            编辑已有房产时不给这个入口——小区/弄/号在编辑态本来就锁着 */}
        {!target && (
          <Form.Item
            label="一句话地址"
            extra="把整句地址粘进来点「拆分」，自动填下面的路名 / 小区 / 弄 / 号 / 室。和小程序语音报修用的是同一套识别"
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="如：剑川路198弄3号301室"
                value={quickAddress}
                onChange={(e) => setQuickAddress(e.target.value)}
                onPressEnter={(e) => { e.preventDefault(); parseQuickAddress(); }}
                allowClear
              />
              <Button type="primary" loading={parsing} onClick={parseQuickAddress}>拆分</Button>
            </Space.Compact>
          </Form.Item>
        )}
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
  const [offices, setOffices] = useState<Array<{ id: number; name: string }>>([]);
  const [parentId, setParentId] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    request<Array<{ id: number; name: string }>>({ url: '/communities/offices' })
      .then(setOffices)
      .catch(() => setOffices([]));
  }, [open]);

  const startEdit = (c: Community | null) => {
    setEditing(c);
    setParentId(c?.parentId ?? null);
    if (c) {
      form.setFieldsValue({
        name: c.name,
        address: c.address,
        parentId: c.parentId ?? null,
        officeId: c.officeId ?? null,
      });
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
          data: {
            name: v.name,
            address: v.address,
            parentId: v.parentId ?? null,
            officeId: v.parentId ? null : v.officeId ?? null,
          },
        });
        message.success('已保存');
      } else {
        await request({
          method: 'POST',
          url: '/communities',
          data: { ...v, officeId: v.parentId ? null : v.officeId ?? null },
        });
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
      title="小区管理"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={1020}
    >
      <Row gutter={16}>
        <Col span={canEdit ? 16 : 24}>
          <Table
            rowKey="id"
            size="small"
            dataSource={communities}
            pagination={false}
            columns={[
              {
                title: '名称', dataIndex: 'name', width: 170,
                render: (v, r) => (
                  <span>
                    {v}
                    {r.isGroup && <Tag color="blue" style={{ marginLeft: 6 }}>上级</Tag>}
                  </span>
                ),
              },
              {
                title: '所属管理处', dataIndex: 'officeName', width: 150,
                render: (v: string | null | undefined, r) =>
                  v
                    ? <span>{v}{r.parentId && <Text type="secondary">（随上级）</Text>}</span>
                    : <Text type="warning">未划入</Text>,
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
        <Col span={8}>
          <Card size="small" title={editing ? `编辑「${editing.name}」` : '新建小区'}>
            <Form form={form} layout="vertical">
              <Form.Item name="name" label="小区名称" rules={[{ required: true }]}>
                <Input placeholder="如：阳光花园" />
              </Form.Item>
              <Form.Item
                name="parentId"
                label="上级小区"
                extra="只有真正分期的小区才填，如「枫桦景苑一期」的上级是「枫桦景苑」；不分期就留空"
              >
                <Select
                  allowClear
                  placeholder="不挂上级"
                  options={withOptionTitles(parentOptions)}
                  onChange={(v) => setParentId(v ?? null)}
                  {...searchableWideSelectProps}
                />
              </Form.Item>
              <Form.Item
                name="officeId"
                label="所属管理处"
                extra={
                  parentId
                    ? '分期跟随上级小区的管理处，不用单独选'
                    : '管理处在「管理处」页面新建；这里选了之后，该管理处的角色就能看到这个小区'
                }
              >
                <Select
                  allowClear
                  disabled={!!parentId}
                  placeholder={parentId ? '跟随上级小区' : '未划入任何管理处'}
                  options={withOptionTitles(offices.map((o) => ({ value: o.id, label: o.name })))}
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

// ============= 公区点位 Modal =============

interface CommunitySpot {
  id: number;
  communityId: number;
  buildingId: number | null;
  buildingText?: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
}

/** 「一键补齐」用的常用点位，和小程序「具体位置」快捷词保持同一批 */
const COMMON_SPOT_NAMES = ['监控室', '门卫室', '水泵房', '电梯机房', '垃圾房', '配电间'];

/**
 * 公区点位维护。
 *
 * 为什么不在房产列表里加一条「商铺」：监控室、水泵房这些地方没有业主、没有面积、
 * 不收物业费，塞进房产台账会弄脏统计和收费口径；而且报修地址识别找房号只按数字撞，
 * 名字叫「监控室」的房号永远撞不上。登记在这里之后，报修描述里说到点位名就能
 * 直接认出来 ——「监控室2号显示屏不亮」认成「枫桦景苑二期 监控室」，
 * 而不是错挂到 228弄2号楼、让维修工白跑一趟。
 */
function CommunitySpotsModal({
  open,
  communities,
  defaultCommunityId,
  onClose,
}: {
  open: boolean;
  communities: Community[];
  defaultCommunityId?: number;
  onClose: () => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('properties');
  const [form] = Form.useForm();
  // 分组节点（「枫桦景苑」）不挂楼栋也不挂点位，只能选到分期这一层
  const leaves = useMemo(() => communities.filter((c) => !c.isGroup), [communities]);
  const [communityId, setCommunityId] = useState<number | undefined>(defaultCommunityId);
  const [rows, setRows] = useState<CommunitySpot[]>([]);
  const [buildings, setBuildings] = useState<Array<{ id: number; lane: string | null; buildingNo: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<CommunitySpot | null>(null);

  useEffect(() => {
    if (!open) return;
    setCommunityId((prev) => prev ?? defaultCommunityId ?? leaves[0]?.id);
  }, [open, defaultCommunityId, leaves]);

  const load = useCallback(async () => {
    if (!open || !communityId) { setRows([]); return; }
    setLoading(true);
    try {
      const [spots, bs] = await Promise.all([
        request<CommunitySpot[]>({ url: '/community-spots', query: { communityId } }),
        request<Array<{ id: number; lane: string | null; buildingNo: string }>>({
          url: '/buildings',
          query: { communityId },
        }),
      ]);
      setRows(spots);
      setBuildings(bs);
    } catch (e: any) {
      message.error(e?.message || '加载公区点位失败');
    } finally {
      setLoading(false);
    }
  }, [open, communityId, message]);

  useEffect(() => { load(); }, [load]);
  // 换小区时把半填的表单收掉，免得把 A 小区的点位存到 B 小区去
  useEffect(() => { setEditing(null); form.resetFields(); }, [communityId, form]);

  const buildingOptions = buildings.map((b) => ({
    value: b.id,
    label: `${b.lane ? b.lane + '弄' : ''}${b.buildingNo}号`,
  }));

  const startEdit = (row: CommunitySpot) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      buildingId: row.buildingId ?? undefined,
      enabled: row.enabled,
    });
  };

  const onSubmit = async () => {
    const v = await form.validateFields();
    if (!communityId) return;
    setSaving(true);
    try {
      if (editing) {
        await request({
          method: 'PATCH',
          url: `/community-spots/${editing.id}`,
          data: { name: v.name, buildingId: v.buildingId ?? null, enabled: v.enabled ?? true },
        });
        message.success('已保存');
      } else {
        await request({
          method: 'POST',
          url: '/community-spots',
          data: {
            communityId,
            name: v.name,
            buildingId: v.buildingId ?? null,
            enabled: v.enabled ?? true,
          },
        });
        message.success('点位已新增');
      }
      form.resetFields();
      setEditing(null);
      load();
    } catch (e: any) {
      if (editing && handleGone(e, message, '这个点位', () => { setEditing(null); load(); })) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onDelete = (row: CommunitySpot) => {
    modal.confirm({
      title: `确认删除点位「${row.name}」?`,
      content: '删除后这个词不再参与报修地址识别；已经开出去的工单不受影响。',
      okType: 'danger',
      onOk: async () => {
        try {
          await request({ method: 'DELETE', url: `/community-spots/${row.id}` });
          message.success('已删除');
          load();
        } catch (e: any) {
          if (handleGone(e, message, '这个点位', load)) return;
          message.error(e?.message || '删除失败');
        }
      },
    });
  };

  const missingCommon = COMMON_SPOT_NAMES.filter(
    (name) => !rows.some((r) => r.name === name),
  );

  const addCommon = async () => {
    if (!communityId || !missingCommon.length) return;
    setSaving(true);
    try {
      for (const name of missingCommon) {
        await request({
          method: 'POST',
          url: '/community-spots',
          data: { communityId, name },
        });
      }
      message.success(`已补上 ${missingCommon.length} 个常用点位`);
      load();
    } catch (e: any) {
      message.error(e?.message || '批量添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="公区点位"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={1020}
    >
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        监控室、门卫室、水泵房这类地方<Text strong>没有房号</Text>，不该当成商铺录进房产台账
        （没业主、没面积、不收费，录进去会把统计弄脏）。登记在这里之后，报修描述里说到
        点位名就能<Text strong>直接认出地址</Text> ——「监控室2号显示屏不亮」会认成
        「{leaves.find((c) => c.id === communityId)?.name || '本小区'} 监控室」，
        而不是撞到 2 号楼上让维修工白跑一趟。
      </Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Text strong>小区</Text>
        <Select
          value={communityId}
          onChange={setCommunityId}
          options={withOptionTitles(leaves.map((c) => ({ value: c.id, label: c.name })))}
          style={{ width: 240 }}
          {...searchableWideSelectProps}
        />
        {canEdit && missingCommon.length > 0 && (
          <Button
            icon={<PlusOutlined />}
            loading={saving}
            disabled={!communityId}
            onClick={addCommon}
          >
            一键补上常用点位（{missingCommon.length}）
          </Button>
        )}
      </Space>
      <Row gutter={16}>
        <Col span={canEdit ? 15 : 24}>
          <Table<CommunitySpot>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={rows}
            pagination={false}
            locale={{ emptyText: '这个小区还没登记公区点位' }}
            columns={[
              { title: '点位名称', dataIndex: 'name', width: 160 },
              {
                title: '所在楼栋',
                dataIndex: 'buildingText',
                width: 140,
                render: (v: string) => v || <Text type="secondary">整个小区</Text>,
              },
              {
                title: '状态',
                dataIndex: 'enabled',
                width: 90,
                render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
              },
              {
                title: '操作',
                key: 'op',
                width: 100,
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
          <Col span={9}>
            <Card size="small" title={editing ? `编辑「${editing.name}」` : '新增点位'}>
              <Form form={form} layout="vertical" initialValues={{ enabled: true }}>
                <Form.Item
                  name="name"
                  label="点位名称"
                  rules={[
                    { required: true, message: '请输入点位名称' },
                    { min: 2, message: '至少 2 个字，太短会在描述里误撞' },
                    { pattern: /[^0-9０-９]/, message: '不能是纯数字，会和门牌号混掉' },
                  ]}
                  extra="报修描述里出现这个词就按它定位，写维修工认得的叫法（监控室、水泵房）"
                >
                  <Input placeholder="如：监控室" maxLength={20} />
                </Form.Item>
                <Form.Item
                  name="buildingId"
                  label="所在楼栋"
                  extra="在某一栋楼里（如 3 号楼电梯机房）才选；整个小区共用的留空"
                >
                  <Select
                    allowClear
                    placeholder="整个小区"
                    options={withOptionTitles(buildingOptions)}
                    {...searchableWideSelectProps}
                  />
                </Form.Item>
                <Form.Item name="enabled" label="参与地址识别" valuePropName="checked">
                  <Switch checkedChildren="启用" unCheckedChildren="停用" />
                </Form.Item>
                <Space>
                  <Button type="primary" loading={saving} onClick={onSubmit} disabled={!communityId}>
                    {editing ? '保存' : '新增'}
                  </Button>
                  {editing && (
                    <Button onClick={() => { setEditing(null); form.resetFields(); }}>取消</Button>
                  )}
                </Space>
              </Form>
            </Card>
          </Col>
        )}
      </Row>
    </Modal>
  );
}
