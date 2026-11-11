import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Table } from 'antd';
import { request } from '@pms/api-client';

export interface ReconciliationDetailQuery {
  from: string; to: string; communityId?: number; feeCode?: string; communityType?: 'apartment';
  paymentMethod?: string; amountKind?: 'charged' | 'refunded'; dimension?: 'day'; key?: string;
}
interface DetailRow {
  id: string | number; source: string; occurredAt: string; communityName?: string;
  address: string; ownerName?: string; feeName: string; amountCents: number; method: string; receiptNo?: string; cashier?: string;
}
export default function FeeReconciliationDetail({ query, onClose }: { query: ReconciliationDetailQuery | null; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [count, setCount] = useState(0);
  const [amount, setAmount] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setPage(1); }, [query]);
  useEffect(() => {
    let current = true;
    if (!query) return;
    setLoading(true); setError(''); setRows([]); setCount(0); setAmount(0);
    request<{ rows: DetailRow[]; count: number; totals: { amountCents: number } }>({ url: '/fees/reports/detail', query: { ...query, source: 'pms', limit: 50, offset: (page - 1) * 50 } })
      .then(r => { if (current) { setRows(r.rows); setCount(r.count); setAmount(r.totals.amountCents); } })
      .catch(e => { if (current) setError(e.message || '明细读取失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, page, retry]);
  const money = (v: number) => (Number(v || 0) / 100).toFixed(2);
  return <Modal open={!!query} title="财务对账明细" onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width="min(1200px, 96vw)">
    <Space wrap style={{ marginBottom: 16 }}>
      <span>{query?.dimension === 'day' ? query.key : `${query?.from} 至 ${query?.to}`}</span>
      <span>{query?.communityType === 'apartment' ? '仅公寓' : '当前授权范围'}</span>
      {query?.paymentMethod && <span>收款方式：{query.paymentMethod}</span>}
      {query?.amountKind && <span>{query.amountKind === 'charged' ? '收款' : '红冲及退费'}</span>}
      <span>共 {count} 条明细 · 净额 ¥{money(amount)}</span>
    </Space>
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => setRetry(v => v + 1)}>重试</Button>} />}
    <Table rowKey={r => `${r.source}:${r.id}`} size="small" loading={loading} dataSource={rows} scroll={{ x: 1150 }}
      pagination={{ current: page, pageSize: 50, total: count, showSizeChanger: false, onChange: setPage }} columns={[
        { title: '收款日期', dataIndex: 'occurredAt', width: 180, render: (v: string) => new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) },
        { title: '小区 / 公寓', dataIndex: 'communityName', width: 140 },
        { title: '地址', dataIndex: 'address', width: 200, ellipsis: true },
        { title: '业主', dataIndex: 'ownerName', width: 100 },
        { title: '费用项目', dataIndex: 'feeName', width: 120 },
        { title: '金额（元）', dataIndex: 'amountCents', width: 120, align: 'right', render: money },
        { title: '收款方式', dataIndex: 'method', width: 120 },
        { title: '收据号', dataIndex: 'receiptNo', width: 180 },
        { title: '收费员', dataIndex: 'cashier', width: 100 },
      ]} />
  </Modal>;
}
