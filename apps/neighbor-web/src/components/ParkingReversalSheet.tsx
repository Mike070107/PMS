import { useRef, useState } from 'react';
import { formatBeijingDateTime } from '@pms/shared-types';
import { request } from '@pms/api-client';
import { Sheet } from '@/components/ui';
import { money, payLabel } from '@/lib/format';

interface ParkingPayment {
  id: number;
  txnNo: string;
  plateNo?: string;
  createdAt: string;
  amountCents: number;
  paymentMethod: string | null;
}

export default function ParkingReversalSheet({ payment, onClose, onReversed }: {
  payment: ParkingPayment;
  onClose: () => void;
  onReversed: (result: { reversalTxnNo: string; amountCents: number }) => void;
}) {
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const close = () => { if (!inFlight.current) onClose(); };

  async function submit() {
    if (inFlight.current) return;
    const note = reason.trim();
    if (!note) {
      setInvalid(true);
      input.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ reversalTxnNo: string; amountCents: number }>({
        method: 'POST',
        url: `/business/transaction-ledger/${payment.id}/reverse`,
        data: { reason: note },
      });
      onReversed(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : '红冲结果待核对，请查看原流水后再试');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <Sheet open onClose={close} title="红冲停车收款" subtitle={payment.txnNo} width={460}>
    <form className="rec-reverse-form" noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="rec-detail-grid">
        <div className="rec-detail-item"><span>车牌</span><b>{payment.plateNo || '—'}</b></div>
        <div className="rec-detail-item"><span>收款时间</span><b>{formatBeijingDateTime(payment.createdAt,'YYYY-MM-DD HH:mm')}</b></div>
        <div className="rec-detail-item"><span>原金额</span><b>{money(payment.amountCents / 100)} · {payment.paymentMethod ? payLabel(payment.paymentMethod) : '—'}</b></div>
        <div className="rec-detail-item"><span>冲销金额</span><b>{money(-payment.amountCents / 100)}</b></div>
      </div>
      <p className="note2">确认后生成负数红冲单并保留原流水。可安全恢复的停车有效期会排队回退，有后续续费或现场记录不一致时转人工核对。支付渠道退款请另行核对。</p>
      <label htmlFor="parking-reverse-reason">红冲原因 *</label>
      <textarea id="parking-reverse-reason" className="in" ref={input} autoFocus required maxLength={300} rows={3}
        value={reason} disabled={busy} aria-invalid={invalid} aria-describedby={invalid ? 'parking-reverse-reason-error' : undefined}
        onChange={e => { setReason(e.target.value); if (e.target.value.trim()) setInvalid(false); }} />
      {invalid && <small id="parking-reverse-reason-error" role="alert">请填写红冲原因</small>}
      {error && <p role="alert">{error}</p>}
      <div className="rec-actions">
        <button type="button" className="btn" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="btn d" disabled={busy}>{busy ? '处理中…' : '确认红冲'}</button>
      </div>
    </form>
  </Sheet>;
}
