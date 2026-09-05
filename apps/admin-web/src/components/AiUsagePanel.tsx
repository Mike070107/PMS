import { useCallback, useEffect, useState } from 'react';
import { Button, Space, Table, Tag, Typography } from 'antd';
import { request } from '../lib/api';

const { Text, Paragraph } = Typography;

/**
 * 大模型用量月账。2026-09-05 Mike 问「AI 会不会让账单快速涨」，之前只能翻 nginx 日志数请求；
 * 现在每次调用都记在 ai_usage_logs（见服务端 ai-usage.service.ts），这里按月汇总。
 *
 * 两种缓存分开看：
 *   · 「本系统缓存」= 同一句话在缓存天数内直接复用，根本没打服务商；
 *   · 「服务商缓存」= DeepSeek 前缀缓存命中的输入 token，按折扣价计。
 * 费用只在后台填了单价时才估算 —— 不用猜的价格算出一个看着很准的数。
 */
interface UsageSummary {
  month: string;
  calls: number;
  okCalls: number;
  failedCalls: number;
  localCacheHits: number;
  promptTokens: number;
  promptCacheHitTokens: number;
  completionTokens: number;
  providerCacheRatio: number;
  estimatedCostYuan: number | null;
  byKind: Array<{ kind: string; calls: number; localCacheHits: number; promptTokens: number; completionTokens: number }>;
  byDay: Array<{ day: string; calls: number; localCacheHits: number }>;
}

const KIND_LABELS: Record<string, string> = {
  'repair-parse': '一句话报修解析',
  'completion-summary': '完工小结',
  'material-receipt': '入库单识别',
  'material-profile': '材料档案识别',
  test: '连通性测试',
  other: '其他',
};

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const fmt = (n: number) => n.toLocaleString('zh-CN');

export default function AiUsagePanel() {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError('');
    try {
      setData(await request<UsageSummary>({ url: `/settings/ai/usage?month=${m}` }));
    } catch (e: any) {
      setError(e?.message || '加载用量失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [month, load]);

  const providerCalls = data ? data.calls - data.localCacheHits : 0;

  return (
    <div style={{ marginTop: 32 }}>
      <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Text strong>本月用量</Text>
        <Space>
          <Button size="small" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            上月
          </Button>
          <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{month}</Text>
          <Button size="small" disabled={month >= currentMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            下月
          </Button>
          <Button size="small" loading={loading} onClick={() => void load(month)}>
            刷新
          </Button>
        </Space>
      </Space>
      <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 8, marginBottom: 12 }}>
        按 token 计费，不按次数。「本系统缓存」是同一句话在缓存天数内直接复用、没打服务商；
        「服务商缓存」是 DeepSeek 按提示词前缀自动打折的那部分输入。填了下面的单价才会估算费用。
      </Paragraph>
      {error ? <Text type="danger">{error}</Text> : null}
      {data ? (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <Stat label="调用次数" value={fmt(data.calls)} hint={`打到服务商 ${fmt(providerCalls)} 次`} />
            <Stat
              label="本系统缓存命中"
              value={fmt(data.localCacheHits)}
              hint={data.calls ? `${Math.round((data.localCacheHits / data.calls) * 100)}% 的请求没花钱` : '—'}
            />
            <Stat label="失败" value={fmt(data.failedCalls)} hint="超时或服务商报错，已退回规则" tone={data.failedCalls ? 'warn' : undefined} />
            <Stat label="输入 token" value={fmt(data.promptTokens)} hint={`服务商缓存命中 ${Math.round(data.providerCacheRatio * 100)}%`} />
            <Stat label="输出 token" value={fmt(data.completionTokens)} />
            <Stat
              label="估算费用"
              value={data.estimatedCostYuan == null ? '—' : `¥${data.estimatedCostYuan.toFixed(2)}`}
              hint={data.estimatedCostYuan == null ? '在上面填单价后可估算' : '按填写的单价估算，以服务商账单为准'}
            />
          </div>
          <Table
            size="small"
            pagination={false}
            rowKey="kind"
            dataSource={data.byKind}
            locale={{ emptyText: '这个月还没有调用' }}
            columns={[
              {
                title: '用途',
                dataIndex: 'kind',
                render: (k: string) => <Tag>{KIND_LABELS[k] || k}</Tag>,
              },
              { title: '次数', dataIndex: 'calls', align: 'right', render: fmt },
              { title: '其中本系统缓存', dataIndex: 'localCacheHits', align: 'right', render: fmt },
              { title: '输入 token', dataIndex: 'promptTokens', align: 'right', render: fmt },
              { title: '输出 token', dataIndex: 'completionTokens', align: 'right', render: fmt },
            ]}
          />
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div style={{ padding: '12px 14px', border: '1px solid #e5ecf2', borderRadius: 10, background: '#fafcfe' }}>
      <div style={{ fontSize: 13, color: '#5d7388' }}>{label}</div>
      <div
        style={{
          marginTop: 4,
          fontSize: 22,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: tone === 'warn' ? '#b53d44' : '#1f405f',
        }}
      >
        {value}
      </div>
      {hint ? <div style={{ marginTop: 4, fontSize: 12, color: '#8a9bb0' }}>{hint}</div> : null}
    </div>
  );
}
