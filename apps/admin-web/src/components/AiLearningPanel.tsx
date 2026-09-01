import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { request } from '../lib/api';

const { Text, Paragraph } = Typography;

interface RepairTypeOption {
  repairType: string;
  label: string;
}

interface FeeRule {
  id: number;
  code: string;
  name: string;
  repairType: string | null;
  officeId: number | null;
  keywords: string[];
  feeCents: number;
  enabled: boolean;
}

interface Feedback {
  id: number;
  kind: 'repair' | 'completion';
  workOrderId: number | null;
  sourceText: string;
  fieldDiff: Record<string, { before: unknown; after: unknown }>;
  model: string | null;
  createdAt: string;
}

const EMPTY_RULE = {
  code: '',
  name: '',
  repairType: '',
  officeId: undefined as number | undefined,
  keywords: '',
  feeYuan: undefined as number | undefined,
  enabled: true,
};

export default function AiLearningPanel({ canEdit }: { canEdit: boolean }) {
  const { message } = AntdApp.useApp();
  const [types, setTypes] = useState<RepairTypeOption[]>([]);
  const [offices, setOffices] = useState<Array<{ id: number; name: string }>>([]);
  const [rules, setRules] = useState<FeeRule[]>([]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [editing, setEditing] = useState<FeeRule | null>(null);
  const [draft, setDraft] = useState(EMPTY_RULE);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextTypes, nextOffices, nextRules, nextFeedback] = await Promise.all([
        request<RepairTypeOption[]>({ url: '/repair-types' }).catch(() => []),
        request<Array<{ id: number; name: string }>>({ url: '/repair-type-rules/offices' }).catch(() => []),
        request<FeeRule[]>({ url: '/settings/ai/fee-rules' }),
        request<Feedback[]>({ url: '/settings/ai/feedback?status=pending' }),
      ]);
      setTypes(nextTypes);
      setOffices(nextOffices);
      setRules(nextRules);
      setFeedback(nextFeedback);
    } catch (e: any) {
      message.error(e?.message || '加载 AI 学习配置失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => void load(), [load]);

  const openRule = (row?: FeeRule) => {
    setEditing(row || null);
    setDraft(
      row
        ? {
            code: row.code,
            name: row.name,
            repairType: row.repairType || '',
            officeId: row.officeId || undefined,
            keywords: (row.keywords || []).join('、'),
            feeYuan: row.feeCents / 100,
            enabled: row.enabled,
          }
        : EMPTY_RULE,
    );
    setRuleOpen(true);
  };

  const saveRule = async () => {
    if (!draft.code.trim() || !draft.name.trim() || draft.feeYuan == null) {
      return message.warning('请填规则编码、名称和金额');
    }
    setSaving(true);
    try {
      await request({
        method: editing ? 'PATCH' : 'POST',
        url: editing ? `/settings/ai/fee-rules/${editing.id}` : '/settings/ai/fee-rules',
        data: {
          code: draft.code.trim(),
          name: draft.name.trim(),
          repairType: draft.repairType || undefined,
          officeId: draft.officeId,
          keywords: draft.keywords.split(/[、,，\s]+/).map((v) => v.trim()).filter(Boolean),
          feeCents: Math.round(draft.feeYuan * 100),
          enabled: draft.enabled,
        },
      });
      setRuleOpen(false);
      await load();
      message.success('收费规则已保存');
    } catch (e: any) {
      message.error(e?.message || '保存失败（规则编码不能重复）');
    } finally {
      setSaving(false);
    }
  };

  const updateRule = async (row: FeeRule, patch: Partial<FeeRule>) => {
    try {
      await request({
        method: 'PATCH',
        url: `/settings/ai/fee-rules/${row.id}`,
        data: { ...row, ...patch },
      });
      await load();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  const removeRule = async (row: FeeRule) => {
    try {
      await request({ method: 'DELETE', url: `/settings/ai/fee-rules/${row.id}` });
      await load();
      message.success('收费规则已删除');
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  const review = async (row: Feedback, action: 'promote' | 'ignore') => {
    try {
      await request({ method: 'POST', url: `/settings/ai/feedback/${row.id}/${action}` });
      await load();
      message.success(action === 'promote' ? '已收为正式识别样例' : '已忽略这次修改');
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  return (
    <div style={{ marginTop: 28 }}>
      <Text strong>维修收费规则</Text>
      <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 4 }}>
        AI 只能从这里选择收费建议，不能自己编金额。没有匹配规则时收费栏保持空白，最终仍由维修工确认。
      </Paragraph>
      <Table<FeeRule>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rules}
        pagination={false}
        columns={[
          { title: '规则', render: (_, row) => <><div>{row.name}</div><Text type="secondary">{row.code}</Text></> },
          {
            title: '适用范围',
            render: (_, row) => (
              <Space size={[4, 4]} wrap>
                <Tag color={row.officeId ? 'blue' : 'default'}>{offices.find((item) => item.id === row.officeId)?.name || '公司通用'}</Tag>
                <Tag>{types.find((item) => item.repairType === row.repairType)?.label || '全部类型'}</Tag>
                {(row.keywords || []).map((word) => <Tag key={word}>{word}</Tag>)}
              </Space>
            ),
          },
          { title: '建议金额', width: 110, render: (_, row) => `¥${(row.feeCents / 100).toFixed(2)}` },
          {
            title: '启用', width: 75,
            render: (_, row) => <Switch size="small" checked={row.enabled} disabled={!canEdit} onChange={(enabled) => updateRule(row, { enabled })} />,
          },
          ...(canEdit ? [{
            title: '', width: 130,
            render: (_: unknown, row: FeeRule) => <Space>
              <Button type="link" size="small" onClick={() => openRule(row)}>编辑</Button>
              <Popconfirm title="删除这条收费规则？" onConfirm={() => removeRule(row)}>
                <Button type="link" danger size="small">删除</Button>
              </Popconfirm>
            </Space>,
          }] : []),
        ]}
      />
      {canEdit ? <Button style={{ marginTop: 12 }} onClick={() => openRule()}>新增收费规则</Button> : null}

      <div style={{ marginTop: 30 }}>
        <Space>
          <Text strong>待审核的人工纠错</Text>
          <Tag color={feedback.length ? 'orange' : 'default'}>{feedback.length}</Tag>
        </Space>
        <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 4 }}>
          系统会比较 AI 草稿和最终提交。只有在这里点“收为样例”后，修改才会进入下一次识别，避免自动学错。
        </Paragraph>
        <Table<Feedback>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={feedback}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无待审核纠错' }}
          columns={[
            {
              title: '原话',
              render: (_, row) => <><Tag>{row.kind === 'repair' ? '报修' : '完工'}</Tag>{row.sourceText}</>,
            },
            {
              title: '人工改了什么', width: 360,
              render: (_, row) => (
                <Space direction="vertical" size={3}>
                  {Object.entries(row.fieldDiff || {}).map(([field, value]) => (
                    <Text key={field} style={{ fontSize: 12 }}>
                      {field}：{show(value.before)} → <Text strong>{show(value.after)}</Text>
                    </Text>
                  ))}
                </Space>
              ),
            },
            ...(canEdit ? [{
              title: '', width: 155,
              render: (_: unknown, row: Feedback) => <Space>
                <Button type="link" size="small" onClick={() => review(row, 'promote')}>收为样例</Button>
                <Button type="link" size="small" onClick={() => review(row, 'ignore')}>忽略</Button>
              </Space>,
            }] : []),
          ]}
        />
      </div>

      <Modal
        title={editing ? '编辑维修收费规则' : '新增维修收费规则'}
        open={ruleOpen}
        onCancel={() => setRuleOpen(false)}
        onOk={saveRule}
        confirmLoading={saving}
        okText="保存"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input value={draft.code} disabled={!!editing} placeholder="规则编码，如 replace_angle_valve" onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          <Input value={draft.name} placeholder="规则名称，如 更换普通角阀" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Select allowClear value={draft.repairType || undefined} placeholder="适用报修类型（不选=全部）" options={types.map((item) => ({ value: item.repairType, label: item.label }))} onChange={(repairType) => setDraft({ ...draft, repairType: repairType || '' })} />
          <Select allowClear value={draft.officeId} placeholder="适用管理处（不选=公司通用）" options={offices.map((item) => ({ value: item.id, label: item.name }))} onChange={(officeId) => setDraft({ ...draft, officeId })} />
          <Input value={draft.keywords} placeholder="适用词，如 更换角阀、换角阀（顿号分隔）" onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
          <Space>
            <Text>建议金额（元）</Text>
            <InputNumber min={0} precision={2} value={draft.feeYuan} onChange={(feeYuan) => setDraft({ ...draft, feeYuan: feeYuan ?? undefined })} />
            <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
            <Text>启用</Text>
          </Space>
        </Space>
      </Modal>
    </div>
  );
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.join('、') || '空';
  if (value === null || value === undefined || value === '') return '空';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
