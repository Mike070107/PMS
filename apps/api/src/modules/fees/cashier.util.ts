import { BadRequestException } from '@nestjs/common';
import { FeeBillStatus } from '../../common/enums';

export interface CashierItemInput {
  feeCode: string;
  quantity?: number;
  unit?: string;
  unitPriceCents?: number;
  amountCents: number;
  serviceFrom?: string;
  serviceTo?: string;
  vehiclePlate?: string;
  remark?: string;
}

export function normalizeCashierContact(name?: string, phone?: string) {
  return {
    name: name?.trim() || null,
    phone: phone?.trim() || null,
  };
}

export function mergeCashierContact(
  current: { name: string | null; phone: string | null },
  incoming: { name: string | null; phone: string | null },
) {
  return {
    name: incoming.name ?? current.name,
    phone: incoming.phone ?? current.phone,
  };
}

/** 原收据被红冲后留在备注里的标记，和旧系统口径一致。 */
export const REFUNDED_MARK = '【已被红冲】';

export function assertReceiptRefundable(bills: { status: string }[]) {
  if (bills.some((bill) => bill.status === FeeBillStatus.REFUNDED)) {
    throw new BadRequestException('这张收据已经红冲过，不能重复红冲');
  }
  if (bills.some((bill) => bill.status !== FeeBillStatus.PAID)) {
    throw new BadRequestException('只有已收款的收据可以红冲');
  }
}

export function reversalRemark(originalReceiptNo: string, reason?: string | null) {
  return [`红冲 ${originalReceiptNo}`, reason?.trim() || null].filter(Boolean).join('；');
}

/** 重复红冲已被接口拦住，这里再去重一次，避免备注被叠成一串标记。 */
export function markRefundedRemark(remark: string | null) {
  if (remark?.includes(REFUNDED_MARK)) return remark;
  return `${remark ?? ''}${REFUNDED_MARK}`;
}

export function normalizeCashierItems(items: CashierItemInput[]) {
  if (!items.length) throw new BadRequestException('请至少添加一个收费项目');
  return items.map((item) => {
    const quantity = item.quantity === undefined ? null : Number(item.quantity.toFixed(3));
    const unitPriceCents = item.unitPriceCents ?? null;
    if (item.amountCents < 0) throw new BadRequestException('收费金额不能小于 0');
    return {
      feeCode: item.feeCode,
      quantity: quantity === null ? null : quantity.toFixed(3),
      unit: item.unit?.trim() || null,
      unitPriceCents,
      amountCents: item.amountCents,
      serviceFrom: item.serviceFrom || null,
      serviceTo: item.serviceTo || null,
      vehiclePlate: item.vehiclePlate?.trim() || null,
      remark: item.remark?.trim() || null,
    };
  });
}
