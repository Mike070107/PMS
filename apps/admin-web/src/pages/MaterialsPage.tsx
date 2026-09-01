import {
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import { handleGone } from '../lib/gone';
import { usePagePerm } from '../lib/auth';
import { useTableSeq } from '../components/tableSeqColumn';
import UnitSelect from '../components/UnitSelect';
import {
  MATERIAL_PHOTO_LIMIT,
  MaterialPhotoCell,
  MaterialPhotosUpload,
  materialPhotoList,
} from '../components/MaterialPhotos';
import { MATERIAL_CATEGORIES } from '@pms/shared-types';

const { Title, Text } = Typography;

const CATEGORY_OPTIONS = MATERIAL_CATEGORIES.map((c) => ({ value: c, label: c }));

interface MaterialRow {
  id: number;
  code: string;
  name: string;
  spec?: string | null;
  category?: string | null;
  unit: string;
  defaultCostCents: number;
  photoUrl?: string | null;
  photoUrls?: string[];
  aliases?: string[];
  params?: string | null;
  enabled: boolean;
}

export default function MaterialsPage() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('materials');
  const [rows, setRows] = useState<MaterialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MaterialRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await request<MaterialRow[]>({ url: '/materials' });
      setRows(r);
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (categoryFilter && row.category !== categoryFilter) return false;
      if (!kw) return true;
      const haystack = [
        row.name, row.spec, row.code, row.category,
        ...(row.aliases || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(kw);
    });
  }, [rows, keyword, categoryFilter]);

  const seq = useTableSeq<MaterialRow>(filtered.length, { defaultPageSize: 20 });

  const openCreate = () => { setEditing(null); setEditorOpen(true); };
  const openEdit = (row: MaterialRow) => { setEditing(row); setEditorOpen(true); };

  const toggleEnabled = async (row: MaterialRow) => {
    try {
      await request({
        method: 'PATCH',
        url: `/materials/${row.id}`,
        data: { enabled: !row.enabled },
      });
      message.success(row.enabled ? `已停用「${row.name}」` : `已启用「${row.name}」`);
      load();
    } catch (e: any) {
      if (handleGone(e, message, '这个材料', load)) return;
      message.error(e?.message || '操作失败');
    }
  };

  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}><AppstoreOutlined /> 材料 SKU 库</Title>
          <Text type="secondary">
            全系统材料的唯一来源：缺料申请、采购、入库、调拨、完工用料一律从这里选择。
            判重口径：名称 + 型号相同为同一材料；被业务单据引用后名称和型号锁定不可改。
          </Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增 SKU</Button>
          )}
        </Space>
      </Space>

      <Card>
        <Space style={{ marginBottom: 14 }} wrap>
          <Input.Search
            allowClear
            placeholder="搜索名称 / 别名 / 型号 / 编码"
            style={{ width: 300 }}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={setKeyword}
          />
          <Select
            allowClear
            placeholder="按类别筛选"
            style={{ width: 160 }}
            options={CATEGORY_OPTIONS}
            value={categoryFilter}
            onChange={setCategoryFilter}
          />
          <Text type="secondary">共 {filtered.length} 条</Text>
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          tableLayout="fixed"
          // x 必须 ≥ 各列宽度之和：小于总和时，没写 width 的那列只能分到剩下的几十像素，
          // 表头中文会被压成竖排（2026-08-31 在 1366 宽的屏上量到「详细参数」只剩 36px）
          scroll={{ x: 1464 }}
          pagination={seq.pagination}
          columns={[
            seq.column,
            {
              title: '照片',
              key: 'photos',
              width: 84,
              // 点开是整组大图，可左右翻（一条 SKU 最多 4 张）
              render: (_, row) => <MaterialPhotoCell item={row} size={52} />,
            },
            { title: '编码', dataIndex: 'code', width: 120 },
            {
              title: '名称',
              dataIndex: 'name',
              width: 200,
              render: (v, row) => (
                <Space size={4}>
                  <span style={{ fontWeight: 600 }}>{v}</span>
                  {!row.enabled && <Tag>停用</Tag>}
                </Space>
              ),
            },
            { title: '型号', dataIndex: 'spec', width: 140, render: (v) => v || <Text type="secondary">-</Text> },
            {
              title: '别名',
              dataIndex: 'aliases',
              width: 200,
              render: (aliases: string[] | undefined) => aliases?.length
                ? <Space size={[4, 4]} wrap>{aliases.map((a) => <Tag key={a}>{a}</Tag>)}</Space>
                : <Text type="secondary">-</Text>,
            },
            { title: '类别', dataIndex: 'category', width: 100, render: (v) => v || '-' },
            { title: '单位', dataIndex: 'unit', width: 70 },
            {
              title: '参考成本',
              dataIndex: 'defaultCostCents',
              width: 110,
              render: (v) => v ? `¥ ${(v / 100).toFixed(2)}` : '-',
            },
            {
              title: '详细参数',
              dataIndex: 'params',
              width: 220,
              ellipsis: true,
              render: (v) => v ? <Tooltip title={v}>{v}</Tooltip> : <Text type="secondary">-</Text>,
            },
            {
              title: '操作',
              key: 'op',
              width: 140,
              fixed: 'right',
              render: (_, row) => canEdit ? (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                  <Button type="link" size="small" danger={row.enabled} onClick={() => toggleEnabled(row)}>
                    {row.enabled ? '停用' : '启用'}
                  </Button>
                </Space>
              ) : <Text type="secondary">-</Text>,
            },
          ]}
        />
      </Card>

      <MaterialEditorModal
        open={editorOpen}
        editing={editing}
        allRows={rows}
        onClose={() => setEditorOpen(false)}
        onDone={() => { setEditorOpen(false); load(); }}
      />
    </div>
  );
}

function MaterialEditorModal({
  open, editing, allRows, onClose, onDone,
}: {
  open: boolean;
  editing: MaterialRow | null;
  allRows: MaterialRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const nameValue = Form.useWatch('name', form);
  const specValue = Form.useWatch('spec', form);
  const photoUploading = Form.useWatch('photoUploading', form);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        spec: editing.spec || undefined,
        category: editing.category || undefined,
        unit: editing.unit,
        defaultCostYuan: editing.defaultCostCents ? editing.defaultCostCents / 100 : undefined,
        aliases: editing.aliases || [],
        params: editing.params || undefined,
        photoUrls: materialPhotoList(editing),
        enabled: editing.enabled,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ unit: '个', enabled: true, aliases: [], photoUrls: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // 名称联想：已有名称 + 别名去重
  const nameOptions = useMemo(() => {
    const names = new Set<string>();
    allRows.forEach((row) => {
      names.add(row.name);
    });
    const kw = (nameValue || '').trim().toLowerCase();
    return Array.from(names)
      .filter((n) => !kw || n.toLowerCase().includes(kw))
      .slice(0, 8)
      .map((n) => ({ value: n }));
  }, [allRows, nameValue]);

  // 型号联想：同名材料下已有的型号
  const specOptions = useMemo(() => {
    const name = (nameValue || '').trim();
    if (!name) return [];
    const specs = new Set<string>();
    allRows.forEach((row) => {
      if (row.name === name && row.spec) specs.add(row.spec);
    });
    const kw = (specValue || '').trim().toLowerCase();
    return Array.from(specs)
      .filter((s) => !kw || s.toLowerCase().includes(kw))
      .slice(0, 8)
      .map((s) => ({ value: s }));
  }, [allRows, nameValue, specValue]);

  // 库里已经在用的单位，保证历史上手填的特殊单位不会从下拉里消失
  const usedUnits = useMemo(
    () => Array.from(new Set(allRows.map((row) => row.unit).filter(Boolean))),
    [allRows],
  );

  // 前端判重提示（后端仍强校验）
  const dupRow = useMemo(() => {
    const name = (nameValue || '').trim();
    const spec = (specValue || '').trim();
    if (!name) return null;
    return allRows.find(
      (row) =>
        row.id !== editing?.id &&
        row.name.trim() === name &&
        (row.spec || '').trim() === spec,
    ) || null;
  }, [allRows, nameValue, specValue, editing]);

  const onSave = async () => {
    const v = await form.validateFields();
    if (v.photoUploading) {
      message.warning('照片还在上传，请稍后再保存');
      return;
    }
    if (dupRow) {
      message.error(`已存在同名同型号材料（编码 ${dupRow.code}），请直接使用或将本名称加为它的别名`);
      return;
    }
    setSaving(true);
    try {
      await request({
        method: editing ? 'PATCH' : 'POST',
        url: editing ? `/materials/${editing.id}` : '/materials',
        data: {
          name: v.name.trim(),
          spec: v.spec?.trim() || undefined,
          category: v.category,
          unit: v.unit || '个',
          defaultCostCents: v.defaultCostYuan != null ? Math.round(v.defaultCostYuan * 100) : 0,
          aliases: v.aliases || [],
          params: v.params?.trim() || undefined,
          photoUrls: v.photoUrls || [],
          enabled: v.enabled ?? true,
        },
      });
      message.success(editing ? 'SKU 已更新' : 'SKU 已创建');
      onDone();
    } catch (e: any) {
      if (editing && handleGone(e, message, '这个材料', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? `编辑 SKU：${editing.code}` : '新增材料 SKU'}
      okText="保存"
      confirmLoading={saving}
      okButtonProps={{ disabled: !!photoUploading }}
      onOk={onSave}
      onCancel={onClose}
      width={640}
      destroyOnHidden
    >
      {editing && (
        <div style={{
          marginBottom: 14, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(49,85,138,0.06)', fontSize: 13,
        }}>
          <LockOutlined /> 被业务单据引用后，名称和型号将锁定不可改（保存时校验）；其余栏位可随时更新。
        </div>
      )}
      <Form form={form} layout="vertical">
        <Space.Compact block>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入材料名称' }]}
            style={{ flex: 1, marginRight: 12 }}
          >
            <AutoComplete
              options={nameOptions}
              placeholder="输入时自动联想已有名称"
            />
          </Form.Item>
          <Form.Item name="spec" label="型号" style={{ flex: 1 }}>
            <AutoComplete
              options={specOptions}
              placeholder="同名下已有型号自动联想"
            />
          </Form.Item>
        </Space.Compact>
        {dupRow && (
          <div style={{ color: '#b23a3a', marginTop: -8, marginBottom: 12, fontSize: 13 }}>
            已存在同名同型号材料（编码 {dupRow.code}）——同名不同型号才允许新建
          </div>
        )}
        <Space.Compact block>
          <Form.Item
            name="category"
            label="类别"
            rules={[{ required: true, message: '请选择类别' }]}
            style={{ flex: 1, marginRight: 12 }}
          >
            <Select options={CATEGORY_OPTIONS} placeholder="选择类别（决定编码前缀）" />
          </Form.Item>
          <Form.Item
            name="unit"
            label="单位"
            rules={[{ required: true, message: '请选择单位' }]}
            style={{ width: 140, marginRight: 12 }}
          >
            <UnitSelect usedUnits={usedUnits} />
          </Form.Item>
          <Form.Item name="defaultCostYuan" label="参考成本（元）" tooltip="入库后自动刷新为剩余批次的加权均价；只用于估价和展示，领料成本按实际入库批次算" style={{ width: 150 }}>
            <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="0.00" />
          </Form.Item>
        </Space.Compact>
        <Form.Item
          name="aliases"
          label="别名（同物异名，如：胶布 / 透明胶，输入后回车）"
        >
          <Select mode="tags" open={false} tokenSeparators={[',', '，', ' ']} placeholder="输入别名后回车，可多个" />
        </Form.Item>
        <Form.Item name="params" label="详细参数">
          <Input.TextArea rows={3} maxLength={2000} placeholder="材质 / 尺寸 / 技术参数等" />
        </Form.Item>
        <Form.Item
          name="photoUrls"
          label={`实物照片（最多 ${MATERIAL_PHOTO_LIMIT} 张）`}
          tooltip="正面 / 侧面 / 铭牌 / 包装各一张，维修工在库房靠它认货；第一张作封面，在列表和选料弹层里显示"
        >
          <MaterialPhotosUpload
            onUploadingChange={(uploading) => form.setFieldsValue({ photoUploading: uploading })}
          />
        </Form.Item>
        <Form.Item name="photoUploading" hidden valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
