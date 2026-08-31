import { useCallback, useEffect, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Input,
  Modal,
  Popconfirm,
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
  text: string;
  expected: {
    addressText?: string;
    description?: string;
    contactName?: string;
    phone?: string;
    urgent?: boolean;
  };
  note: string;
  enabled: boolean;
}

const EMPTY_DRAFT = {
  text: '',
  addressText: '',
  description: '',
  contactName: '',
  note: '',
};

export default function AiSamplesPanel({ canEdit }: { canEdit: boolean }) {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<AiSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await request<AiSample[]>({ url: '/settings/ai/samples' }));
    } catch (e: any) {
      message.error(e?.message || '加载样例失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!draft.text.trim()) {
      message.warning('先把「这句话」填上');
      return;
    }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/settings/ai/samples',
        data: {
          text: draft.text,
          note: draft.note,
          // 只提交填了的字段：空字段进了提示词会教出「什么都可以不填」
          expected: {
            addressText: draft.addressText || undefined,
            description: draft.description || undefined,
            contactName: draft.contactName || undefined,
          },
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
      <Text strong>识别样例</Text>
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
                {v?.description ? <Tag>描述 {v.description}</Tag> : null}
                {v?.contactName ? <Tag>联系人 {v.contactName}</Tag> : null}
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
        title="加一条识别样例"
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
              placeholder="5511弄，236号，502报修电子门里面，旋钮打滑"
            />
          </div>
          <div>
            <Text strong>应该认出的地址</Text>
            <Input
              value={draft.addressText}
              onChange={(e) => setDraft({ ...draft, addressText: e.target.value })}
              placeholder="5511弄，236号，502（照抄原话里表示地点的那一段；中文数字写成阿拉伯数字）"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              这里教的是「哪一段是地址」。真正的门牌仍然要回房产库里撞，撞不上系统不会填。
            </Text>
          </div>
          <div>
            <Text strong>应该认出的故障描述</Text>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="电子门旋钮打滑，居民出不去"
            />
          </div>
          <div>
            <Text strong>应该认出的联系人</Text>
            <Input
              value={draft.contactName}
              onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
              placeholder="没说人名就留空"
            />
          </div>
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
