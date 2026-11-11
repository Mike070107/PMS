import { BadRequestException } from '@nestjs/common';

/** 已有预留不属于可再次分配的库存；调用方须先锁住库存行。 */
export function assertReservationCapacity(stock: number, reservedByOthers: number, requested: number): void {
  if (![stock, reservedByOthers, requested].every(Number.isFinite) || requested < 0 || reservedByOthers < 0) {
    throw new BadRequestException('用料数量无效');
  }
  if (requested > Math.round((stock - reservedByOthers) * 100) / 100) {
    throw new BadRequestException('可用库存不足，其他工单可能已锁定库存');
  }
}
