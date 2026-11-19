import { BadRequestException } from '@nestjs/common';
type Receipt = {
  receiptNo: string;
  fullAddress?: string | null;
  communityName?: string | null;
  lane?: string | null;
  buildingNo?: string | null;
  roomNo?: string | null;
  amountCents: number;
  paidAt: Date | string | null;
  cashier?: string | null;
  status?: string;
  paymentMethod?: string | null;
  items: Array<{
    feeName: string;
    amountCents: number;
    quantity?: number | null;
    unit?: string | null;
    vehiclePlate?: string | null;
    serviceFrom?: string | null;
    serviceTo?: string | null;
  }>;
};
export function receiptLines(r: Receipt, reprint: boolean): string[] {
  if (!r.items.length || r.items.length > 20)
    throw new BadRequestException('收费项目数量超过小票限制或为空');
  const money = (cents: number) => (cents / 100).toFixed(2);
  const time = r.paidAt
    ? new Date(r.paidAt).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '';
  const lines = [
    reprint ? '公寓收费小票（补打）' : '公寓收费小票',
    '票号 ' + r.receiptNo,
    time,
    r.fullAddress ||
      [r.communityName, r.lane, r.buildingNo, r.roomNo].filter(Boolean).join(' '),
  ];
  for (const item of r.items) {
    lines.push(
      item.feeName +
        ' ' +
        money(item.amountCents) +
        (item.quantity != null ? ' ×' + item.quantity + (item.unit || '') : ''),
    );
    if (item.vehiclePlate || item.serviceFrom || item.serviceTo)
      lines.push(
        [item.vehiclePlate, item.serviceFrom, item.serviceTo]
          .filter(Boolean)
          .join(' '),
      );
  }
  lines.push('合计 ￥' + money(r.amountCents));
  if (r.paymentMethod) {
    const labels: Record<string,string> = {cash:'现金',wechat:'微信',alipay:'支付宝',bank:'银行转账',cheque:'支票',other:'其他'};
    lines.push('收款方式 '+(Object.prototype.hasOwnProperty.call(labels,r.paymentMethod)?labels[r.paymentMethod]:r.paymentMethod));
  }
  if (r.cashier) lines.push('收款人 ' + r.cashier);
  if (r.status === 'refunded' || r.amountCents < 0)
    lines.push(r.amountCents < 0 ? '红冲退款' : '原收据已红冲');
  const content = lines.filter(Boolean);
  if (
    content.length > 32 ||
    content.some(
      (s) => s.length > 90 || /[\u0000-\u001f\u007f-\u009f]/.test(s),
    ) ||
    content.reduce(
      (n, s) =>
        n +
        Math.ceil(
          [...s].reduce((l, c) => l + (c.charCodeAt(0) > 127 ? 2 : 1), 0) / 42,
        ),
      0,
    ) > 45
  )
    throw new BadRequestException('票面内容超过安全打印范围');
  return content;
}
