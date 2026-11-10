import * as base from './access-browser-api';
import * as mis from './mis-browser-api';
export { address, notifications, accessCardIssuance } from './access-browser-api';

const w = window as any;
export const configure = () => undefined;
export class ApiError extends Error {}
export const repairs = { list: async () => { if (w.__erpFailOrders) throw Error('synthetic'); return []; } };

const REPORT_DETAIL_ROWS = [
  { id: 1, source: 'pms', occurredAt: '2026-11-01T10:20:00+08:00', officeCode: '02', officeName: '锦川公寓', communityId: 1, communityName: '锦川公寓', address: '198/6/502', ownerName: '合成业主甲', feeCode: 'rent', feeName: '合成租金', amountCents: 500000, method: 'cash', cashier: '合成员工', receiptNo: 'PJ20261101001' },
  { id: 2, source: 'mis', occurredAt: '2026-11-01T15:00:00+08:00', officeCode: '01', officeName: '枫桦景苑一期', communityId: null, communityName: '枫桦景苑一期', address: '228/3/402', ownerName: '合成业主乙', feeCode: 'rent', feeName: '合成租金', amountCents: 300000, method: 'wechat', cashier: '旧系统收款', receiptNo: 'RK20261101002' },
];
const DETAIL_AMOUNTS: Record<string, number> = {
  'community:1': 500000, 'community:01': 300000, 'fee:rent': 800000,
  'method:cash': 800000, 'cashier:合成员工': 800000, 'day:2026-11-01': 1200000,
};

export async function request<T>(o: any): Promise<T> {
  if (o.url === '/fees/reports/summary') {
    w.__calls.push(o);
    await new Promise((r) => setTimeout(r, 80));
    if (w.__erpFailReport) throw Error('synthetic');
    const totals = { netCents: 800000, chargedCents: 1200000, refundedCents: 400000, receiptCount: 3, houseCount: 2, itemCount: 3 };
    return {
      range: { from: '2026-11-01', to: '2026-11-03', granularity: 'day' },
      totals, previous: totals, growth: { netCents: 0, receiptCount: 0, houseCount: 0 },
      trend: [{ day: '2026-11-01', amountCents: 1200000, count: 1 }, { day: '2026-11-02', amountCents: 0, count: 1 }, { day: '2026-11-03', amountCents: -400000, count: 1 }],
      byFee: [{ feeCode: 'rent', feeName: '合成租金', amountCents: 800000, count: 3, share: 1 }],
      byMethod: [{ method: 'cash', amountCents: 800000, count: 3, share: 1 }],
      byCashier: [{ cashier: '合成员工', amountCents: 800000, count: 3, share: 1 }],
      byCommunity: [
        { communityId: 1, communityName: '锦川公寓', source: 'pms', amountCents: 500000, count: 2, share: 0.625 },
        { communityId: null, communityName: '枫桦景苑一期', source: 'mis', officeCode: '01', amountCents: 300000, count: 1, share: 0.375 },
      ],
      sourceNote: '旧系统小区金额来自 MIS 镜像实收（收款日期口径）。',
      message: null,
    } as T;
  }
  if (o.url === '/fees/reports/detail') {
    w.__calls.push(o);
    await new Promise((r) => setTimeout(r, 60));
    const dimension = String(o.query?.dimension || '');
    const key = String(o.query?.key || '');
    if (w.__feeDetailEmpty) return { rows: [], totals: { count: 0, amountCents: 0 }, count: 0, limit: 200, offset: 0, message: null } as T;
    const amountCents = DETAIL_AMOUNTS[`${dimension}:${key}`] ?? 0;
    return {
      rows: REPORT_DETAIL_ROWS, totals: { count: 450, amountCents },
      count: 450, limit: Number(o.query?.limit || 200), offset: Number(o.query?.offset || 0), message: null,
    } as T;
  }
  if (o.url === '/business/transaction-ledger' || o.url === '/fees/mis/options' || o.url === '/fees/mis/ledger') return mis.request<T>(o);
  return base.request<T>(o);
}
