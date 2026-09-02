import { BadRequestException } from '@nestjs/common';

/** 数量都是两位小数的 numeric；减法后 toFixed(2) 抹掉 0.1+0.2 的浮点尾巴（同 stock-ledger） */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

export interface StocktakeCountedItem {
  materialId: number;
  countedQty?: number | null;
}

export interface StocktakeLine {
  materialId: number;
  countedQty: number;
  systemQty: number;
  diffQty: number;
}

/**
 * 过账前的差异计算。抽成纯函数是为了单测口径，服务里过账只按这份结果动台账：
 * - 只算填过实盘数的行（countedQty == null 视为「这行没盘」，过账不动它）；
 * - 差异按传入的**过账时刻**系统数量算，不是建单快照 —— 盘点期间不锁仓；
 * - 材料在该仓没有库存行按 0 算（第一次盘出实物 = 全额盘盈）；
 * - diffQty=0 的行也返回：过账要把 systemQty 写回明细留痕，「账实相符」也是结论。
 */
export function buildStocktakeLines(
  items: StocktakeCountedItem[],
  systemQtyByMaterial: Map<number, number>,
): StocktakeLine[] {
  const lines: StocktakeLine[] = [];
  for (const item of items) {
    if (item.countedQty === null || item.countedQty === undefined) continue;
    const countedQty = Number(item.countedQty);
    if (!Number.isFinite(countedQty) || countedQty < 0) {
      throw new BadRequestException('实盘数量不合法，必须是不小于 0 的数字');
    }
    const systemQty = round2(Number(systemQtyByMaterial.get(item.materialId) ?? 0));
    const counted = round2(countedQty);
    lines.push({
      materialId: item.materialId,
      countedQty: counted,
      systemQty,
      diffQty: round2(counted - systemQty),
    });
  }
  return lines;
}

export interface StocktakeSummary {
  itemCount: number;
  countedCount: number;
  /** 以下四项只统计过账写回的快照（diffQty/amountCents），没过账的单全是 0 */
  profitQty: number;
  lossQty: number;
  profitCents: number;
  lossCents: number;
}

/** 盘盈/盘亏汇总，列表行和审核页共用。金额读过账快照，不在查询时拿当前价现算 */
export function summarizeStocktake(
  items: Array<{
    countedQty?: number | null;
    diffQty?: number;
    amountCents?: number;
  }>,
): StocktakeSummary {
  const summary: StocktakeSummary = {
    itemCount: items.length,
    countedCount: 0,
    profitQty: 0,
    lossQty: 0,
    profitCents: 0,
    lossCents: 0,
  };
  for (const item of items) {
    if (item.countedQty !== null && item.countedQty !== undefined) summary.countedCount += 1;
    const diff = item.diffQty ?? 0;
    if (diff > 0) {
      summary.profitQty = round2(summary.profitQty + diff);
      summary.profitCents += item.amountCents ?? 0;
    } else if (diff < 0) {
      summary.lossQty = round2(summary.lossQty - diff);
      summary.lossCents += item.amountCents ?? 0;
    }
  }
  return summary;
}
