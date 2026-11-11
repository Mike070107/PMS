import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Sheet, toast } from '@/components/ui';
import { payLabel } from '@/lib/format';
import type {
  AnnualBillRow, AnnualBillsResponse, AnnualDetailResponse, AnnualDetailRow, AnnualReceivedDetailRow, StatisticsReportType,
} from '@/lib/statistics';
import { detailQueryParams, fmtArea, fmtCents, fmtPeriod } from '@/lib/statistics';

export interface DetailTarget {
  officeCode: string;
  officeName: string;
  year: number;
  amountCents: number;
}

/**
 * 单元格下钻：
 * - 实收报表（detailKind='received'）：直接是逐笔已收清单（只读、不再下钻），合计必须等于单元格；
 * - 欠费报表：房屋聚合明细 → 点行再进逐笔账单。
 * 合计都由后端返回，不在前端自算，避免与年度表口径不一致。
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
  const mode = detail?.detailKind ?? type;
  const receivedMode = mode === 'received';
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
      .catch((error) => { if (!cancelled) setDetailError(error instanceof Error && error.message ? error.message : '明细读取失败'); })
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

  const houseRows = (detail?.rows ?? []) as AnnualDetailRow[];
  const receivedRows = (detail?.rows ?? []) as AnnualReceivedDetailRow[];
  const billRows = bills?.rows ?? [];
  const mismatch = !!detail && detail.available !== false && detail.totalCents != null
    && !!target && detail.totalCents !== target.amountCents;
  const openBills = (row: AnnualDetailRow) => {
    if (row.sId == null || row.sId === '') { toast('该房屋缺少房屋 id，无法查看逐笔账单'); return; }
    setBillsTarget(row);
  };
  const receivedCount = detail?.count ?? receivedRows.length;

  return (
    <Sheet
      open={opened}
      onClose={onClose}
      width={receivedMode ? 1120 : 860}
      title={target
        ? (receivedMode
          ? `${reportLabel} · 管理处 ${target.officeCode} · ${target.year} 年度`
          : `${target.officeName} · ${target.year} 年度明细`)
        : '年度明细'}
      subtitle={receivedMode ? '逐笔已收清单' : reportLabel}
    >
      {target ? (
        <div className="stats-drawer">
          <div className="stats-drawer-summary">
            <div><span>单元格金额</span><b data-testid="stats-detail-cell-amount">{fmtCents(target.amountCents)}</b></div>
            <div><span>管理处</span><b>{target.officeName}（{target.officeCode}）</b></div>
            <div><span>报表</span><b>{reportLabel}</b></div>
            {receivedMode && detail ? <div><span>笔数</span><b data-testid="stats-received-count">{receivedCount} 笔</b></div> : null}
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
                      {billRows.map((bill: AnnualBillRow) => (
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
                      <tr className="stats-subtotal-row stats-total-row">
                        <td colSpan={2}><b>合计</b></td>
                        <td className="stats-num"><b data-testid="stats-bills-total">{fmtCents(bills?.totalCents ?? 0)}</b></td>
                        <td colSpan={4} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          ) : receivedMode ? (
            <div className="stats-received">
              {detailLoading ? <div className="empty">读取逐笔实收清单…</div> : detailError ? (
                <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
                  <Icon name="alert" />{detailError}
                  <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setDetailRetry((value) => value + 1)}>重试</button>
                </div>
              ) : detail?.available === false ? (
                <div className="note2" role="status"><Icon name="alert" />{detail.message || 'MIS 镜像未覆盖实收逐笔清单，暂不能下钻。'}</div>
              ) : !receivedRows.length ? <div className="empty">该单元格没有逐笔实收流水</div> : (
                <>
                  <div className="stats-drawer-head">
                    <b>逐笔清单</b>
                    <span className="muted">按应收年月归年 · 收款日期可跨年 · 只读</span>
                    <span className="tag mute" style={{ marginLeft: 'auto' }} data-testid="stats-received-count-tag">{receivedCount} 笔</span>
                  </div>
                  <div className="t-scroll">
                    <table className="t stats-received-table">
                      <thead>
                        <tr>
                          <th className="stats-num" style={{ width: 52 }}>序号</th>
                          <th>地址</th>
                          <th>业主姓名</th>
                          <th className="stats-num">建筑面积</th>
                          <th>应收年月</th>
                          <th className="stats-num">实收金额</th>
                          <th>收款日期</th>
                          <th>入库单编号</th>
                          <th>票据编号</th>
                        </tr>
                      </thead>
                      <tbody>
                        {receivedRows.map((row, index) => (
                          <tr key={String(row.zjId ?? index)} data-zj-id={String(row.zjId ?? index)} className="stats-received-row">
                            <td className="stats-num nw">{index + 1}</td>
                            <td><b>{row.address || '—'}</b></td>
                            <td>{row.ownerName || '—'}</td>
                            <td className="stats-num nw">{fmtArea(row.areaSqm)}</td>
                            <td className="nw">{fmtPeriod(row.period)}</td>
                            <td className="stats-num nw">{fmtCents(row.amountCents)}</td>
                            <td className="nw">{row.paidDate || '—'}</td>
                            <td className="nw">{row.receiptNo || '—'}</td>
                            <td className="nw">{row.invoiceNo || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="stats-subtotal-row stats-total-row">
                          <td colSpan={5}><b>合计</b></td>
                          <td className="stats-num"><b data-testid="stats-received-total">{fmtCents(detail?.totalCents ?? 0)}</b></td>
                          <td colSpan={3} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="stats-houses">
              <div className="stats-drawer-head">
                <b>房屋明细</b>
                <span className="muted">按房屋聚合 · 点一行查看逐笔账单</span>
                {detail ? <span className="tag mute" style={{ marginLeft: 'auto' }}>{houseRows.length} 户</span> : null}
              </div>
              {detailLoading ? <div className="empty">读取房屋明细…</div> : detailError ? (
                <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>
                  <Icon name="alert" />{detailError}
                  <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setDetailRetry((value) => value + 1)}>重试</button>
                </div>
              ) : detail?.available === false ? (
                <div className="note2" role="status"><Icon name="alert" />{detail.message || 'MIS 镜像未覆盖房屋明细，暂不能下钻。'}</div>
              ) : !houseRows.length ? <div className="empty">该单元格没有可下钻的房屋明细</div> : (
                <div className="t-scroll">
                  <table className="t stats-detail-table">
                    <thead>
                      <tr><th>地址</th><th>业主</th><th className="stats-num">建筑面积</th><th>{rangeLabel}</th><th className="stats-num">金额</th></tr>
                    </thead>
                    <tbody>
                      {houseRows.map((row, index) => (
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
                      <tr className="stats-subtotal-row stats-total-row">
                        <td colSpan={4}><b>明细合计</b></td>
                        <td className="stats-num"><b data-testid="stats-detail-total">{fmtCents(detail?.totalCents ?? 0)}</b></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {mismatch ? (
            <div className="note2" role="alert" style={{ background: 'var(--warn-w)', color: 'var(--warn)', marginTop: 10 }}>
              <Icon name="alert" />明细合计 {fmtCents(detail?.totalCents ?? 0)} 与单元格金额 {fmtCents(target.amountCents)} 不一致，请重试或联系管理员核对口径。
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
