import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { request } from '../lib/api';

const { Text, Paragraph } = Typography;

/**
 * 识别样例：教大模型「这么说 → 应该这么认」。
 *
 * 为什么要有这一屏：例子写死在代码里的话，每遇到一种新说法都得改代码重新发版，
 * 办公室只能来找开发。放进库里之后谁都能加一条，下一次报修识别就带上了
 * （2026-09-01 用户要求：已经处理过的正例要让 AI 记住，别每次重讲一遍规则）。
 *
 * 用法是 few-shot —— 每条样例都会进**每一次**调用的提示词，所以条数要克制
 * （服务端只取最近 20 条启用的）。教错了先关掉，别急着删，回头要看得出当初为什么这么教。
 */
export interface AiSample {
  id: number;
  /** repair = 一句话报修；completion = 完工小结 */
  kind: string;
  text: string;
  expected: {
    // 一句话报修
    addressText?: string;
    description?: string;
    contactName?: string;
    phone?: string;
    urgent?: boolean;
    publicArea?: boolean;
    repairType?: string;
    // 完工小结
    actionNote?: string;
    faultLocation?: string;
    faultSymptom?: string;
    materials?: string[];
  };
  note: string;
  enabled: boolean;
}

/**
 * 两类样例教的是两件事，字段也不一样，所以表单跟着切换：
 *   repair     维修工/业主说一句报修 → 地址 / 故障描述 / 联系人
 *   completion 维修工干完活说一句   → 维修说明 / 故障位置 / 故障现象
 * 两边的提示词各取各的样例（服务端按 kind 过滤）—— 混着教会互相带偏。
 */
const KINDS = [
  { value: 'repair', label: '一句话报修' },
  { value: 'completion', label: '完工小结' },
] as const;
type SampleKind = (typeof KINDS)[number]['value'];

const FIELDS: Record<SampleKind, Array<{ key: string; label: string; placeholder: string; hint?: string }>> = {
  repair: [
    {
      key: 'repairType',
      label: '应该识别成的报修类型',
      placeholder: '请选择报修类型',
      hint: '类型样例会随原话一起发给 AI；明确的设备关键词仍优先于泛化的故障动作。',
    },
    {
      key: 'addressText',
      label: '应该认出的地址',
      placeholder: '5511弄，236号，502（照抄原话里表示地点的那一段；中文数字写成阿拉伯数字）',
      hint: '这里教的是「哪一段是地址」。真正的门牌仍然要回房产库里撞，撞不上系统不会填。',
    },
    {
      key: 'publicArea',
      label: '故障区域',
      placeholder: '请选择户内或公共区域',
      hint: '按坏的设施判断。住户说了自己房号，但坏的是楼下门、门口机、单元门时，应选公共区域。',
    },
    { key: 'description', label: '应该认出的故障描述', placeholder: '电子门旋钮打滑，居民出不去' },
    { key: 'contactName', label: '应该认出的联系人', placeholder: '没说人名就留空' },
    {
      key: 'phone',
      label: '应该认出的联系电话',
      placeholder: '18201728748',
      hint: '11 位手机号。教它「哪一串数字是电话」—— 门牌号里的数字不能当电话。',
    },
  ],
  completion: [
    {
      key: 'actionNote',
      label: '应该整理成的维修说明',
      placeholder: '更换角阀一只；水管接头加缠生料带',
      hint: '业主会看到这一句。只写实际做了什么，没修成就如实写没修成。',
    },
    { key: 'faultLocation', label: '应该认出的故障位置', placeholder: '厨房水槽下方' },
    { key: 'faultSymptom', label: '应该认出的故障现象', placeholder: '角阀锈蚀卡死' },
    {
      key: 'materials',
      label: '应该认出的用料',
      placeholder: '角阀、生料带（顿号分隔，只写名字不写数量）',
      hint: '这些会自动加进用料清单当草稿行，维修工仍要点「从库存选」绑 SKU 才扣得了库存。',
    },
  ],
};

const EMPTY_DRAFT: Record<string, string> = {
  text: '',
  note: '',
  addressText: '',
  description: '',
  contactName: '',
  actionNote: '',
  faultLocation: '',
  faultSymptom: '',
  phone: '',
  repairType: '',
  publicArea: '',
  materials: '',
};

export default function AiSamplesPanel({ canEdit }: { canEdit: boolean }) {
  const { message } = AntdApp.useApp();
  const [kind, setKind] = useState<SampleKind>('repair');
  const [rows, setRows] = useState<AiSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [repairTypes, setRepairTypes] = useState<Array<{ repairType: string; label: string }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await request<AiSample[]>({ url: `/settings/ai/samples?kind=${kind}` }));
    } catch (e: any) {
      message.error(e?.message || '加载样例失败');
    } finally {
      setLoading(false);
    }
  }, [message, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    request<Array<{ repairType: string; label: string }>>({ url: '/repair-types' })
      .then(setRepairTypes)
      .catch(() => setRepairTypes([]));
  }, []);

  const add = async () => {
    if (!draft.text.trim()) {
      message.warning('先把「这句话」填上');
      return;
    }
    if (kind === 'repair' && !draft.repairType) {
      message.warning('请选择这条样例应该识别成的报修类型');
      return;
    }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/settings/ai/samples',
        data: {
          kind,
          text: draft.text,
          note: draft.note,
          // 只提交填了的字段：空字段进了提示词会教出「什么都可以不填」
          // 用料是数组，页面上按顿号/逗号分隔输入，存进去前拆开
          expected: Object.fromEntries(
            FIELDS[kind]
              .map((f) => [
                f.key,
                f.key === 'materials'
                  ? (draft[f.key] || '')
                      .split(/[、,，\s]+/)
                      .map((x) => x.trim())
                      .filter(Boolean)
                  : f.key === 'publicArea'
                    ? draft.publicArea === 'true'
                      ? true
                      : draft.publicArea === 'false'
                        ? false
                        : undefined
                  : draft[f.key]?.trim(),
              ])
              .filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== '')),
          ),
        },
      });
      setOpen(false);
      setDraft(EMPTY_DRAFT);
      await load();
      message.success('加好了，下一次识别就会带上它');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (row: AiSample, enabled: boolean) => {
    try {
      await request({ method: 'PATCH', url: `/settings/ai/samples/${row.id}`, data: { enabled } });
      await load();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  const remove = async (row: AiSample) => {
    try {
      await request({ method: 'DELETE', url: `/settings/ai/samples/${row.id}` });
      await load();
      message.success('已删除');
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <Space style={{ marginBottom: 8 }}>
        <Text strong>识别样例</Text>
        <Segmented
          size="small"
          value={kind}
          onChange={(v) => setKind(v as SampleKind)}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
      </Space>
      <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 4, marginBottom: 12 }}>
        遇到一种系统没认对的说法，把原话和「应该认成什么」加在这里，
        下一次识别就照着这个口径来，<Text strong>不用等开发改代码</Text>。
        每条样例都会进每一次调用，所以只取最近 20 条启用的 —— 教错了先关掉，不用急着删。
      </Paragraph>

      <Table<AiSample>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          {
            title: '这句话',
            dataIndex: 'text',
            render: (v: string, row) => (
              <div>
                <div>{v}</div>
                {row.note ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {row.note}
                  </Text>
                ) : null}
              </div>
            ),
          },
          {
            title: '应该认成',
            dataIndex: 'expected',
            width: 260,
            render: (v: AiSample['expected']) => (
              <Space direction="vertical" size={2}>
                {v?.addressText ? <Tag color="blue">地址 {v.addressText}</Tag> : null}
                {v?.repairType ? (
                  <Tag color="purple">
                    类型 {repairTypes.find((item) => item.repairType === v.repairType)?.label || v.repairType}
                  </Tag>
                ) : null}
                {v?.description ? <Tag>描述 {v.description}</Tag> : null}
                {v?.contactName ? <Tag>联系人 {v.contactName}</Tag> : null}
                {v?.actionNote ? <Tag color="blue">维修说明 {v.actionNote}</Tag> : null}
                {v?.faultLocation ? <Tag>位置 {v.faultLocation}</Tag> : null}
                {v?.faultSymptom ? <Tag>现象 {v.faultSymptom}</Tag> : null}
                {v?.phone ? <Tag>电话 {v.phone}</Tag> : null}
                {typeof v?.publicArea === 'boolean' ? (
                  <Tag color={v.publicArea ? 'cyan' : 'green'}>
                    {v.publicArea ? '公共区域' : '住户户内'}
                  </Tag>
                ) : null}
                {v?.materials?.length ? <Tag>用料 {v.materials.join('、')}</Tag> : null}
                {v?.urgent ? <Tag color="red">紧急</Tag> : null}
              </Space>
            ),
          },
          {
            title: '启用',
            dataIndex: 'enabled',
            width: 80,
            render: (v: boolean, row) => (
              <Switch size="small" checked={v} disabled={!canEdit} onChange={(next) => toggle(row, next)} />
            ),
          },
          ...(canEdit
            ? [
                {
                  title: '',
                  width: 60,
                  render: (_: unknown, row: AiSample) => (
                    <Popconfirm title="删掉这条样例？" onConfirm={() => remove(row)}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />

      {canEdit && (
        <Button style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
          加一条样例
        </Button>
      )}

      <Modal
        title={`加一条样例 · ${KINDS.find((k) => k.value === kind)?.label}`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={add}
        confirmLoading={saving}
        okText="保存"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text strong>这句话（原话照抄）</Text>
            <Input.TextArea
              rows={2}
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              placeholder={kind === 'completion' ? '换了个角阀，原来那个锈死了' : '5511弄，236号，502报修电子门里面，旋钮打滑'}
            />
          </div>
          {FIELDS[kind].map((f) => (
            <div key={f.key}>
              <Text strong>{f.label}</Text>
              {f.key === 'repairType' ? (
                <Select
                  style={{ width: '100%' }}
                  value={draft.repairType || undefined}
                  onChange={(value) => setDraft({ ...draft, repairType: value })}
                  placeholder={f.placeholder}
                  options={repairTypes.map((item) => ({ value: item.repairType, label: item.label }))}
                />
              ) : f.key === 'publicArea' ? (
                <Select
                  style={{ width: '100%' }}
                  value={draft.publicArea || undefined}
                  onChange={(value) => setDraft({ ...draft, publicArea: value })}
                  placeholder={f.placeholder}
                  options={[
                    { value: 'true', label: '公共区域（楼下门、门口机、单元门等）' },
                    { value: 'false', label: '住户户内' },
                  ]}
                />
              ) : (
                <Input
                  value={draft[f.key]}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                />
              )}
              {f.hint ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {f.hint}
                </Text>
              ) : null}
            </div>
          ))}
          <div>
            <Text strong>备注</Text>
            <Input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder="为什么加这条，如：语音把弄号断成了两段"
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
}
