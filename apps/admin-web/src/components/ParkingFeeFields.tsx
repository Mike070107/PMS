import { useEffect, useState } from 'react';
import { Alert, Button, InputNumber, Modal, Space, Spin, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { accessCardIssuance } from '@pms/api-client';

export const parkingBillingMonths = [1, 2, 3, 6, 12];
export function useParkingRates(open: boolean) {
  const [rates, setRates] = useState<accessCardIssuance.ParkingRates | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError('');
    accessCardIssuance.parkingFeeRates().then((next) => { if (active) setRates(next); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '费率读取失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, reload]);
  return { rates, setRates, error, loading, retry: () => setReload((n) => n + 1),
    amount: (identity: string, months: number) => identity === '亲情车' ? 0 : rates?.[identity === '租户车' ? 'tenant' : 'owner']?.[months] ?? 0 };
}

export default function ParkingFeeFields({ rates, onSaved, identity, months, amount, onAmountChange, loading, error, onRetry, disabled = false }: {
  rates: accessCardIssuance.ParkingRates | null; onSaved: (rates: accessCardIssuance.ParkingRates) => void;
  identity: string; months: number; amount: number | null; onAmountChange: (value: number | null) => void;
  loading: boolean; error: string; onRetry: () => void; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<accessCardIssuance.ParkingRates | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const calculated = identity === '亲情车' ? 0 : rates?.[identity === '租户车' ? 'tenant' : 'owner'][months];
  const save = async () => {
    if (!draft) return;
    setSaving(true); setSaveError('');
    try { const next = await accessCardIssuance.saveParkingFeeRates(draft); onSaved(next); setEditing(false); }
    catch (cause) { setSaveError(cause instanceof Error ? cause.message : '费率保存失败'); }
    finally { setSaving(false); }
  };
  return <>
    <div className="parking-fee-fields">
      <label>本次收费金额<InputNumber min={0} max={1000000} precision={2} value={amount ?? calculated} disabled={disabled || loading || !!error} addonAfter="元" onChange={onAmountChange} /></label>
      <Button icon={<SettingOutlined />} disabled={!rates || loading} onClick={() => { setDraft(structuredClone(rates!)); setSaveError(''); setEditing(true); }}>费率设置</Button>
      {loading ? <Spin size="small" /> : <Typography.Text type="secondary">{disabled ? '亲情车暂存不收费；通过审核后开通车库。' : `按${identity === '租户车' ? '租户车' : '业主车'} ${months}个月费率计算，可修改本次金额。`}</Typography.Text>}
    </div>
    {error && <Alert type="error" message="费率读取失败，暂不能收费" description={error} action={<Button onClick={onRetry}>重试</Button>} />}
    <Modal title="停车费率设置" open={editing} onCancel={() => setEditing(false)} onOk={() => void save()} confirmLoading={saving} okText="保存费率" destroyOnClose>
      <Typography.Paragraph type="secondary">按物业公司保存。新增车牌与续期共用，保存后刷新仍保留；不追溯修改已登记收费。</Typography.Paragraph>
      {saveError && <Alert type="error" message={saveError} />}
      <div className="parking-rates-grid"><strong>缴费周期</strong><strong>业主车</strong><strong>租户车</strong>
        {parkingBillingMonths.map((month) => <Space key={month} style={{ display: 'contents' }}><span>{month}个月</span>{(['owner', 'tenant'] as const).map((key) => <InputNumber key={key} aria-label={`${key === 'owner' ? '业主车' : '租户车'}${month}个月费率`} min={0} max={1000000} precision={2} value={draft?.[key][month]} addonAfter="元" onChange={(value) => { if (value !== null && draft) setDraft({ ...draft, [key]: { ...draft[key], [month]: value } }); }} />)}</Space>)}
      </div>
    </Modal>
  </>;
}
