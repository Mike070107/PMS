import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Sheet, toast } from '@/components/ui';
import { payLabel } from '@/lib/format';
import type {
  AnnualBillRow, AnnualBillsResponse, AnnualDetailResponse, AnnualDetailRow, StatisticsReportType,
} from '@/lib/statistics';
import { detailQueryParams, fmtArea, fmtCents, fmtPeriod } from '@/lib/statistics';

export interface DetailTarget {
  officeCode: string;
  officeName: string;
  year: number;
  amountCents: number;
}

/**
 * 三级下钻：单元格 → 房屋明细（地址/业主/面积/年月范围/金额）→ 逐笔账单。
 * 明细合计与逐笔合计都由后端返回，不在前端自算，避免与年度表口径不一致。
 */
export default function HouseDetailSheet({
  open, onClose, target, type, reportLabel, feeCodes, natures, asOfPeriod, paidDateFrom, paidDateTo,
}: {
  open: boolean;
  onClose: () => void;
  target: DetailTarget | null;
  type: StatisticsReportType;
  reportLabel: string;
  feeCodes: string[];
  natures: string[];
  /** 与年度表同一组截止参数：明细/逐笔合计必须能和单元格对上。 */
  asOfPeriod: string;
  paidDateFrom: string;
  paidDateTo: string;
}) {
  const [detail, setDetail] = useState<AnnualDetailResponse | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRetry, setDetailRetry] = useState(0);
  const [billsTarget, setBillsTarget] = useState<AnnualDetailRow | null>(null);
  const [bills, setBills] = useState<AnnualBillsResponse | null>(null);
  const [billsError, setBillsError] = useState('');
  const [billsLoading, setBillsLoading] = useState(false);
  const [billsRetry, setBillsRetry] = useState(0);

  const feeKey = feeCodes.join(',');
  const natureKey = natures.join(',');
  const officeCode = target?.officeCode ?? '';
  const year = target?.year ?? 0;
  const opened = open && !!target;
  const rangeLabel = type === 'arrears' ? '欠费年月范围' : '所属年月范围';

  useEffect(() => {
    if (!opened) return undefined;
    let cancelled = false;
    setDetail(null); setDetailError(''); setDetailLoading(true);
    setBillsTarget(null); setBills(null); setBillsError('');
    request<AnnualDetailResponse>({
      url: '/statistics/annual/detail',
      query: detailQueryParams({ type, officeCode, year, feeCodes, natures, asOfPeriod, paidDateFrom, paidDateTo }),
    })
      .then((response) => { if (!cancelled) setDetail(response); })
      .catch((error) => { if (!cancelled) setDetailError(error instanceof Error && error.message ? error.message : '房屋明细读取失败'); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [opened, type, officeCode, year, feeKey, natureKey, asOfPeriod, paidDateFrom, paidDateTo, detailRetry]);

  useEffect(() => {
    if (!opened || !billsTarget) return undefined;
    let cancelled = false;
    setBills(null); setBillsError(''); setBillsLoading(true);
    request<AnnualBillsResponse>({
      url: '/statistics/annual/detail/bills',
      query: {
        ...detailQueryParams({ type, officeCode, year, feeCodes, natures, asOfPeriod, paidDateFrom, paidDateTo }),
        sId: billsTarget.sId ?? undefined,
      },
    })
      .then((response) => { if (!cancelled) setBills(response); })
      .catch((error) => { if (!cancelled) setBillsError(error instanceof Error && error.message ? error.message : '逐笔账单读取失败'); })
      .finally(() => { if (!cancelled) setBillsLoading(false); });
    return () => { cancelled = true; };
  }, [opened, type, officeCode, year, feeKey, natureKey, asOfPeriod, paidDateFrom, paidDateTo, billsTarget, billsRetry]);

  const detailRows = detail?.rows ?? [];
  const billRows = bills?.rows ?? [];
  const mismatch = !!detail && detail.available !== false && detail.totalCents != null
    && !!target && detail.totalCents !== target.amountCents;
  const openBills = (row: AnnualDetailRow) => {
    if (row.sId == null) { toast('该房屋缺少房屋 id，无法查看逐笔账单'); return; }
    setBillsTarget(row);
  };

  return (
    <Sheet
      open={opened}
      onClose={onClose}
      width={840}
      title={target ? `${target.officeName} · ${target.year} 年度明细` : '年度明细'}
      subtitle={reportLabel}
    >
      {target ? (
        <div className="stats-drawer">
          <div className="stats-drawer-summary">
            <div><span>单元格金额</span><b data-testid="stats-detail-cell-amount">{fmtCents(target.amountCents)}</b></div>
            <div><span>管理处</span><b>{target.officeName}（{target.officeCode}）</b></div>
            <div><span>报表</span><b>{reportLabel}</b></div>
          </div>

          {billsTarget ? (
            <div className="stats-bills">
              <div className="stats-drawer-head">
                <button type="button" className="btn sm" onClick={() => { setBillsTarget(null); setBills(null); setBillsError(''); }}>
                  <Icon name="chev" size={15} />返回房屋明细
                </button>
                <b>{billsTarget.address || '—'}</b>
                <span className="muted">{billsTarget.ownerName || '—'}</span>
              </div>
              {billsLoading ? <div className="empty">读取逐笔账单…</div> : billsError ? (
                <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
                  <Icon name="alert" />{billsError}
                  <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setBillsRetry((value) => value + 1)}>重试</button>
                </div>
              ) : bills?.available === false ? (
                <div className="note2" role="status"><Icon name="alert" />{bills.message || 'MIS 镜像未覆盖逐笔账单，暂不能下钻。'}</div>
              ) : !billRows.length ? <div className="empty">这套房屋在该年度没有逐笔账单</div> : (
                <div className="t-scroll">
                  <table className="t stats-bills-table">
                    <thead>
                      <tr><th>所属年月</th><th>收费项目</th><th className="stats-num">金额</th><th>收款日期</th><th>退款日期</th><th>收款方式</th><th>收款人</th></tr>
                    </thead>
                    <tbody>
                      {billRows.map((bill) => (
                        <tr key={String(bill.zjId)} data-bill-id={String(bill.zjId)} className="stats-bills-row">
                          <td className="nw">{fmtPeriod(bill.period)}</td>
                          <td>{bill.feeName || '—'}</td>
                          <td className="stats-num">{fmtCents(bill.amountCents)}</td>
                          <td className="nw">{bill.paidDate || '—'}</td>
                          <td className="nw">{bill.refundDate || '—'}</td>
                          <td className="nw">{payLabel(bill.paymentMethod)}</td>
                          <td className="nw">{bill.cashier || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="stats-subtotal-row">
                        <td colSpan={2}><b>合计</b></td>
                        <td className="stats-num"><b data-testid="stats-bills-total">{fmtCents(bills?.totalCents ?? 0)}</b></td>
                        <td colSpan={4} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="stats-houses">
              <div className="stats-drawer-head">
                <b>房屋明细</b>
                <span className="muted">按房屋聚合 · 点一行查看逐笔账单</span>
                {detail ? <span className="tag mute" style={{ marginLeft: 'auto' }}>{detailRows.length} 户</span> : null}
              </div>
              {detailLoading ? <div className="empty">读取房屋明细…</div> : detailError ? (
                <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
                  <Icon name="alert" />{detailError}
                  <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setDetailRetry((value) => value + 1)}>重试</button>
                </div>
              ) : detail?.available === false ? (
                <div className="note2" role="status"><Icon name="alert" />{detail.message || 'MIS 镜像未覆盖房屋明细，暂不能下钻。'}</div>
              ) : !detailRows.length ? <div className="empty">该单元格没有可下钻的房屋明细</div> : (
                <div className="t-scroll">
                  <table className="t stats-detail-table">
                    <thead>
                      <tr><th>地址</th><th>业主</th><th className="stats-num">建筑面积</th><th>{rangeLabel}</th><th className="stats-num">金额</th></tr>
                    </thead>
                    <tbody>
                      {detailRows.map((row, index) => (
                        <tr key={row.sId ?? `${row.address || 'row'}-${index}`} className="row" data-sid={row.sId ?? ''} onClick={() => openBills(row)}>
                          <td><b>{row.address || '—'}</b></td>
                          <td>{row.ownerName || '—'}</td>
                          <td className="stats-num nw">{fmtArea(row.areaSqm)}</td>
                          <td className="nw">{row.periodRange || '—'}</td>
                          <td className="stats-num nw">{fmtCents(row.amountCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="stats-subtotal-row">
                        <td colSpan={4}><b>明细合计</b></td>
                        <td className="stats-num"><b data-testid="stats-detail-total">{fmtCents(detail?.totalCents ?? 0)}</b></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              {mismatch ? (
                <div className="note2" role="alert" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginTop: 10 }}>
                  <Icon name="alert" />明细合计 {fmtCents(detail?.totalCents ?? 0)} 与单元格金额 {fmtCents(target.amountCents)} 不一致，请重试或联系管理员核对口径。
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
