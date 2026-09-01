/**
 * 打印偏移：把整张纸的内容整体挪一挪，抵掉打印机的进纸误差。
 *
 * 为什么需要：套打（往预印好的联单上只打内容）时，内容必须正好落进纸上那些格子。
 * 但每台打印机的进纸都有几毫米的偏差，纸盒导轨没夹紧还会更大 ——
 * 版面本身量得再准也没用，最后一段误差只能在出问题的那台机器上手工补。
 *
 * 正反面分开设：双面打印时反面是另一次走纸，套准误差和正面不是同一个值
 * （普通激光机 ±0.5～1mm），只给一个值补不齐。
 *
 * 存在**这台电脑的浏览器**里（localStorage）：偏移是这台打印机的属性，不是这张单的，
 * 换台电脑对着另一台打印机就该是另一个值，存到服务器上反而会互相覆盖。
 */
export interface PrintOffset {
  /** 正面：右为正、下为正，单位 mm */
  fx: number;
  fy: number;
  /** 反面 */
  bx: number;
  by: number;
}

export const ZERO_OFFSET: PrintOffset = { fx: 0, fy: 0, bx: 0, by: 0 };

const KEY = 'pms.maintenance.printOffset';
/** 再大就不是「补误差」而是版面画错了，限一下省得手滑打飞一整张 */
const LIMIT = 15;

function clamp(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(-LIMIT, Math.min(LIMIT, Math.round(num * 10) / 10));
}

export function readPrintOffset(): PrintOffset {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return ZERO_OFFSET;
    const saved = JSON.parse(raw) as Partial<PrintOffset>;
    return {
      fx: clamp(saved.fx),
      fy: clamp(saved.fy),
      bx: clamp(saved.bx),
      by: clamp(saved.by),
    };
  } catch {
    // 存的东西坏了或隐私模式读不了：当作没设过
    return ZERO_OFFSET;
  }
}

export function savePrintOffset(offset: PrintOffset): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(offset));
  } catch {
    // 同上，存不下就只在这一次打印生效
  }
}

export function isZeroOffset(offset: PrintOffset): boolean {
  return !offset.fx && !offset.fy && !offset.bx && !offset.by;
}

/**
 * 打印文档里追加的那段样式。
 *
 * 用 transform 而不是 margin/top：margin 会把后面几张纸一起顶下去（一次能打好几张），
 * transform 只挪自己、不动版面。背面那条写在后面 —— 两条选择器权重一样，后面的赢。
 */
export function printOffsetCss(offset: PrintOffset): string {
  if (isZeroOffset(offset)) return '';
  return (
    `.mo-sheet{transform:translate(${offset.fx}mm,${offset.fy}mm)}` +
    `.mo-sheet--back{transform:translate(${offset.bx}mm,${offset.by}mm)}`
  );
}
