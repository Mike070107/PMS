import { BadRequestException } from '@nestjs/common';

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
