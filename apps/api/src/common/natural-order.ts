import { SelectQueryBuilder } from 'typeorm';

/**
 * 门牌号/楼号的「自然排序」（human sort）。
 *
 * 为什么需要：room_no / building_no 在库里是 varchar，按字符串排会得到
 * 1001 → 101 → 102 → 1101 → 201 这种顺序（逐字符比较时 '0' < '1'），
 * 业主和物业看的是楼层，必须按数值排：101 → 102 → 201 → 1001 → 1101。
 *
 * 规则：把字符串切成「数字块 / 非数字块」交替比较，数字块按数值比。
 *   101 < 1001                两块都是数字，按数值
 *   157-159 < 218-01 < 218-02 先比 157/218，再比后半段
 *   1403 < 商铺                纯数字排在文字前面，杂项落到最后
 *   空值排最后
 *
 * 两种用法：
 * - SQL 侧：addNaturalOrderBy(qb, 'h.room_no')，让数据库直接吐出正确顺序，
 *   分页/limit 才不会截错行。取「数字前缀」排序，覆盖房号楼号的全部实际形态。
 * - 内存侧：compareNatural / compareBuildingLike，用于 repo.find() 拿回来的
 *   实体数组（TypeORM 的 order 选项塞不了表达式）。
 *
 * 新增任何按房号/楼号出列表的接口，直接用这里的函数，不要再写 order: { id }。
 */

/** 数字块与非数字块交替切分 */
const CHUNKS = /\d+|\D+/g;

function compareNumericChunk(a: string, b: string): number {
  // 去掉前导 0 后先比长度再比字典序：不走 Number()，避免超长数字丢精度
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (left.length !== right.length) return left.length - right.length;
  if (left !== right) return left < right ? -1 : 1;
  // 数值相等时（'1' / '01'）按原串长度定序，保证结果稳定
  return a.length - b.length;
}

/** 自然序比较，可直接丢给 Array.prototype.sort */
export function compareNatural(a?: string | null, b?: string | null): number {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (left === right) return 0;
  if (!left) return 1; // 空值排最后
  if (!right) return -1;

  const leftChunks = left.match(CHUNKS) ?? [];
  const rightChunks = right.match(CHUNKS) ?? [];
  const size = Math.min(leftChunks.length, rightChunks.length);
  for (let i = 0; i < size; i += 1) {
    const x = leftChunks[i];
    const y = rightChunks[i];
    const xIsNum = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
    const yIsNum = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
    if (xIsNum && yIsNum) {
      const diff = compareNumericChunk(x, y);
      if (diff) return diff;
    } else if (xIsNum !== yIsNum) {
      return xIsNum ? -1 : 1; // 数字块优先：101 排在「商铺」前
    } else {
      const diff = x.localeCompare(y, 'zh-Hans-CN');
      if (diff) return diff;
    }
  }
  return leftChunks.length - rightChunks.length;
}

/** 楼栋按「弄 → 号 → id」自然排序 */
export function compareBuildingLike(
  a: { lane?: string | null; buildingNo?: string | null; id?: number },
  b: { lane?: string | null; buildingNo?: string | null; id?: number },
): number {
  return (
    compareNatural(a.lane, b.lane) ||
    compareNatural(a.buildingNo, b.buildingNo) ||
    (a.id ?? 0) - (b.id ?? 0)
  );
}

/**
 * ORDER BY 用的数字前缀表达式：'1001'→1001，'157-159'→157，'商铺'→NULL（排最后）。
 * 用 numeric 而不是 int，长数字串不会溢出。
 */
export function naturalNumberSql(column: string): string {
  return `NULLIF(substring(${column} from '^[0-9]+'), '')::numeric`;
}

/**
 * 追加一组自然排序的 ORDER BY：先按数字前缀，再按原串兜底
 * （'218-01' / '218-02' 这种数字前缀相同的靠第二条分开）。
 */
export function addNaturalOrderBy(
  qb: SelectQueryBuilder<any>,
  column: string,
  direction: 'ASC' | 'DESC' = 'ASC',
): SelectQueryBuilder<any> {
  qb.addOrderBy(naturalNumberSql(column), direction, 'NULLS LAST');
  qb.addOrderBy(column, direction, 'NULLS LAST');
  return qb;
}
