import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import { handleGone } from '../lib/gone';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

const { Title, Text } = Typography;

interface OfficeRow {
  id: number;
  name: string;
  remark: string | null;
  enabled: boolean;
  communities: { id: number; name: string }[];
}

interface OfficesResp {
  offices: OfficeRow[];
  unassigned: { id: number; name: string }[];
}

export default function OfficesPage() {
  const { message } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('offices');
  const [data, setData] = useState<OfficesResp>({ offices: [], unassigned: [] });
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<OfficeRow | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await request<OfficesResp>({ url: '/offices' }));
    } catch (e: any) {
      message.error(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { load(); }, [load]);

  const remove = async (r: OfficeRow) => {
    try {
      await request({ method: 'DELETE', url: `/offices/${r.id}` });
      message.success('已删除');
      load();
    } catch (e: any) {
      if (handleGone(e, message, '这个管理处', load)) return;
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <div>
      {data.unassigned.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`还有 ${data.unassigned.length} 个小区未划入任何管理处：${data.unassigned.map((c) => c.name).join('、')}`}
          description="未划入管理处的小区无法通过「按管理处」的数据范围授权，建议尽快划分。"
        />
      )}
      <Card
        title="公司 → 管理处 → 小区：一个管理处管多个小区，角色数据范围可按管理处授权"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            {canEdit && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                新建管理处
              </Button>
            )}
          </Space>
        }
      >
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={data.offices}
          pagination={false}
          columns={[
            {
              title: '管理处', dataIndex: 'name', width: 220,
              render: (v: string, r) => (
                <Space size={6}>
                  <span style={{ fontWeight: 600 }}>{v}</span>
                  {!r.enabled && <Tag>已停用</Tag>}
                </Space>
              ),
            },
            {
              title: '管辖小区', dataIndex: 'communities',
              render: (list: OfficeRow['communities']) =>
                list.length
                  ? list.map((c) => <Tag key={c.id}>{c.name}</Tag>)
                  : <Text type="secondary">尚未划入小区</Text>,
            },
            { title: '备注', dataIndex: 'remark', width: 200, render: (v) => v || '-' },
            {
              title: '操作', key: 'op', width: 140,
              render: (_, r) => (
                <Space size={0}>
                  {canEdit && (
                    <Button type="link" size="small" onClick={() => setEditing(r)}>编辑</Button>
                  )}
                  {canDelete && (
                    <Popconfirm
                      title="删除该管理处？"
                      description="需先转移或移出其下小区，且没有角色的数据范围指向它。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => remove(r)}
                    >
                      <Button type="link" size="small" danger>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <OfficeFormModal
        open={creating || !!editing}
        target={editing}
        allData={data}
        onClose={() => { setCreating(false); setEditing(null); }}
        onDone={() => { setCreating(false); setEditing(null); load(); }}
      />
    </div>
  );
}

function OfficeFormModal({
  open, target, allData, onClose, onDone,
}: {
  open: boolean;
  target?: OfficeRow | null;
  allData: OfficesResp;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  // 可选小区 = 未分配的 + 本处已有的（其他管理处的不给选，先在那边移出）
  const options = useMemo(() => {
    const own = target?.communities ?? [];
    const merged = [...own, ...allData.unassigned];
    const seen = new Set<number>();
    return merged.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  }, [target, allData.unassigned]);

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({
        name: target.name,
        remark: target.remark ?? undefined,
        enabled: target.enabled,
        communityIds: target.communities.map((c) => c.id),
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ enabled: true, communityIds: [] });
    }
  }, [open, target, form]);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const data = {
        name: v.name,
        remark: v.remark || undefined,
        enabled: v.enabled,
        communityIds: v.communityIds ?? [],
      };
      if (target) {
        await request({ method: 'PATCH', url: `/offices/${target.id}`, data });
      } else {
        await request({ method: 'POST', url: '/offices', data });
      }
      message.success('已保存');
      onDone();
    } catch (e: any) {
      if (target && handleGone(e, message, '这个管理处', onDone)) return;
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={target ? `编辑管理处「${target.name}」` : '新建管理处'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="管理处名称" rules={[{ required: true, message: '请填写名称' }]}>
          <Input placeholder="如：枫桦景苑管理处" />
        </Form.Item>
        <Form.Item name="remark" label="备注（选填）">
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item
          name="communityIds"
          label="管辖小区"
          extra="只列出未分配的小区；已属于其他管理处的小区请先在原管理处移出。选顶层小区即可，分期跟随。"
        >
          <Select
            mode="multiple"
            placeholder="可多选"
            options={withOptionTitles(options.map((c) => ({ value: c.id, label: c.name })))}
            {...searchableWideSelectProps}
          />
        </Form.Item>
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
