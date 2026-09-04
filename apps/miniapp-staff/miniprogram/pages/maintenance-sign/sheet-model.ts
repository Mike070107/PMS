/**
 * 《房屋修理养护任务单》的**纸面数据模型**：把一张养护单摊成正面 / 存根 / 背面三组「行 × 格」，
 * 每格带宽度（mm）、种类和要显示的文字。页面（maintenance-sign.ts）拿它去渲染，
 * 预览脚本（tools 里的 HTML mock）也拿它出图核对版式 —— 所以这个文件不能引用 wx.* 任何东西。
 *
 * 尺寸表来自 @pms/shared-types 的 maintenance-sheet-geometry，和 Web 打印稿同一份。
 */
import {
  ADDR_SLOTS,
  BACK_COLS,
  BACK_ROW_H,
  CHECK_GROUPS,
  DETAIL_COLS,
  DETAIL_HEAD_SPLIT,
  FOOTER,
  QUOTA_GROUP_W,
  ROW1,
  ROW2,
  ROW3,
  ROW_H,
  STUB_LABEL_NARROW,
  STUB_LABEL_WIDE,
  STUB_ROWS,
} from '@pms/shared-types';

export type SignSlot = 'filler' | 'repairer' | 'inspector' | 'owner';

/** 一格。w 单位 mm，0 = 撑满剩余；值和标签都已经是最终要显示的文字 */
export interface SheetCell {
  w: number;
  kind:
    | 'lb' | 'txt' | 'addr' | 'sign' | 'inspector' | 'quota' | 'voucher'
    | 'total' | 'paren' | 'tick' | 'ymd' | 'vpair' | 'empty';
  lb?: string;
  small?: boolean;
  txt?: string;
  left?: boolean;
  /** 小一档的值：规格/单位、备注、定额编号（格子窄，正文字号装不下） */
  fs?: 'spec' | 'note' | 'code';
  wrap?: boolean;
  slot?: SignSlot;
  url?: string;
  name?: string;
  target?: boolean;
  village?: string; road?: string; lane?: string; building?: string; room?: string;
  on?: boolean;
  y?: string; m?: string; d?: string;
  quotaCode?: number; quotaHours?: number;
}
export interface SheetRow { h: number; cells: SheetCell[]; }
export interface SheetPage {
  no: string;
  noLong: boolean;
  pageMark: string;
  unitName: string;
  front: SheetRow[];
  stub: SheetRow[];
  back: SheetRow[];
  scrap: string;
  materialTotal: string;
}

/** 正面一张纸 4 行明细，背面 7 行材料 —— 与 Web 端 types.ts 同一口径 */
export const ITEMS_PER_SHEET = 4;
export const MATERIALS_PER_SHEET = 7;

const PART_OPTIONS = [
  { value: 'self', label: '自用\n部位' },
  { value: 'shared', label: '共用\n部位' },
  { value: 'public', label: '公共\n设施' },
];
const FEE_OPTIONS = [
  { value: 'owner', label: '业主\n自理' },
  { value: 'repair_fund', label: '修缮\n基金' },
  { value: 'elevator_fund', label: '电梯水\n泵基金' },
  { value: 'public_fund', label: '公共设\n施基金' },
];
const SHARE_OPTIONS = [
  { value: 'natural', label: '自然\n幢' },
  { value: 'door', label: '门牌\n幢' },
  { value: 'zone', label: '住宅\n区域' },
];

/** WXML 里 mo-cell 模板要用的几个尺寸常量（mm），一起交给页面 data */
export const SHEET_CONSTANTS = {
  /** 值的字号（mm）：正文 3.4，规格/单位 2.6，备注 2.8，定额编号 2.5 —— 与 Web 端 CSS 同值 */
  fsOf: { txt: 3.4, spec: 2.6, note: 2.8, code: 2.5 },
  addr: ADDR_SLOTS,
  quotaSplit: DETAIL_HEAD_SPLIT,
};

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}
function num(value: unknown): string {
  return value === null || value === undefined || value === '' ? '' : String(value);
}
function yuan(cents: unknown): string {
  const n = Number(cents);
  return cents === null || cents === undefined || !Number.isFinite(n) ? '' : (n / 100).toFixed(2);
}
export function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
/** 纸上写「8/11」 */
function md(value: unknown): string {
  const date = parseDate(value);
  return date ? `${date.getMonth() + 1}/${date.getDate()}` : '';
}
function ymd(value: unknown): { y: string; m: string; d: string } {
  const date = parseDate(value);
  return date
    ? { y: String(date.getFullYear()), m: String(date.getMonth() + 1), d: String(date.getDate()) }
    : { y: '', m: '', d: '' };
}
/** 竖排字段名：小程序不认 writing-mode，一个字一行 */
function vertical(label: string): string {
  return label.split('').join('\n');
}
/** 实体联单号：多张纸时后面几张顺延（与 Web 端 paperNoForSheet 一致） */
function paperNoForSheet(order: Record<string, any>, pageNo: number): string {
  const raw = text(order.paperNo);
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) return raw;
  return String(Number(raw) + pageNo - 1).padStart(raw.length, '0');
}

const lb = (w: number, label: string, small = false): SheetCell => ({ w, kind: 'lb', lb: label, small });
const txt = (w: number, value: string, extra: Partial<SheetCell> = {}): SheetCell => ({ w, kind: 'txt', txt: value, ...extra });

function tickGroup(
  options: { value: string; label: string }[],
  sizes: readonly (readonly [number, number])[],
  value: unknown,
): SheetCell[] {
  const cells: SheetCell[] = [];
  options.forEach((opt, i) => {
    cells.push(lb(sizes[i][0], opt.label, true));
    cells.push({ w: sizes[i][1], kind: 'tick', on: text(value) === opt.value });
  });
  return cells;
}

/** 签名格：签了显示手迹；本次要签的那一格高亮、可点；草稿签好了先落在这一格预览 */
function signCell(
  w: number,
  slot: SignSlot,
  order: Record<string, any>,
  urlKey: string,
  nameKey: string | null,
  target: SignSlot,
  draft: string,
  kind: 'sign' | 'inspector' = 'sign',
): SheetCell {
  const isTarget = slot === target;
  const cell: SheetCell = {
    w,
    kind,
    slot,
    target: isTarget,
    url: isTarget && draft ? draft : text(order[urlKey]),
    name: nameKey ? text(order[nameKey]) : '',
  };
  if (kind === 'inspector') {
    const at = parseDate(order.inspectedAt);
    cell.m = at ? String(at.getMonth() + 1) : '';
    cell.d = at ? String(at.getDate()) : '';
  }
  return cell;
}

export function buildPages(order: Record<string, any>, target: SignSlot, draft: string): SheetPage[] {
  const items: Record<string, any>[] = Array.isArray(order.items) ? order.items : [];
  const materials: Record<string, any>[] = Array.isArray(order.materials) ? order.materials : [];
  const count = Math.max(
    1,
    Math.ceil(items.length / ITEMS_PER_SHEET),
    Math.ceil(materials.length / MATERIALS_PER_SHEET),
  );
  const pages: SheetPage[] = [];
  for (let pageNo = 1; pageNo <= count; pageNo += 1) {
    const isLast = pageNo === count;
    const no = paperNoForSheet(order, pageNo);
    const pageMark = count > 1 ? `（第 ${pageNo} 页 / 共 ${count} 页）` : '';

    // ---------- 正面 ----------
    const front: SheetRow[] = [];
    front.push({
      h: ROW_H.reporter,
      cells: [
        lb(ROW1[0], '报修人\n姓名'),
        txt(ROW1[1], text(order.reporterName)),
        lb(ROW1[2], '地址'),
        {
          w: ROW1[3],
          kind: 'addr',
          village: text(order.addrVillage),
          road: text(order.addrRoad),
          lane: text(order.addrLane),
          building: text(order.addrBuildingNo),
          room: text(order.addrRoom),
        },
        lb(ROW1[4], '报修\n日期'),
        txt(ROW1[5], md(order.reportedOn)),
        lb(ROW1[6], '有人\n时间'),
        txt(ROW1[7], text(order.presentTime)),
        lb(0, '报修人(户)验收'),
      ],
    });
    front.push({
      h: ROW_H.part,
      cells: [
        lb(ROW2[0], '报修\n部位'),
        txt(ROW2[1], text(order.faultPart)),
        lb(ROW2[2], '报修\n项目'),
        txt(ROW2[3], text(order.repairItem)),
        lb(ROW2[4], '预约\n日期'),
        txt(ROW2[5], md(order.appointOn)),
        lb(ROW2[6], '开工\n日期'),
        txt(ROW2[7], md(order.startOn)),
        lb(ROW2[8], '完工\n日期'),
        txt(ROW2[9], md(order.finishOn)),
        signCell(0, 'owner', order, 'ownerSignUrl', null, target, draft),
      ],
    });
    front.push({
      h: ROW_H.category,
      cells: [
        { w: ROW3[0], kind: 'paren', lb: '修缮日期（', txt: text(order.repairDateText) },
        { w: ROW3[1], kind: 'paren', lb: '费用类别（', txt: text(order.feeCategoryText) },
        { w: 0, kind: 'paren', lb: '分摊方式（', txt: text(order.shareMethodText) },
      ],
    });
    front.push({
      h: ROW_H.checks,
      cells: [
        ...tickGroup(PART_OPTIONS, CHECK_GROUPS.part, order.partCategory),
        ...tickGroup(FEE_OPTIONS, CHECK_GROUPS.fee, order.feeCategory),
        ...tickGroup(SHARE_OPTIONS, CHECK_GROUPS.share, order.shareMethod),
      ],
    });
    front.push({
      h: ROW_H.detailHead,
      cells: [
        lb(DETAIL_COLS.part, '查勘\n部位'),
        lb(DETAIL_COLS.name, '查勘修理项目'),
        lb(DETAIL_COLS.surveyQty, '查勘\n数量'),
        lb(DETAIL_COLS.actualQty, '实做\n数量'),
        lb(DETAIL_COLS.actualHours, '实做\n工时'),
        lb(DETAIL_COLS.measureQty, '量方\n数量'),
        { w: QUOTA_GROUP_W, kind: 'quota', quotaCode: DETAIL_COLS.quotaCode, quotaHours: DETAIL_COLS.quotaHours },
        lb(DETAIL_COLS.materialFee, '材料费'),
        lb(DETAIL_COLS.quality, '质量\n验收'),
        lb(0, '备注'),
      ],
    });
    const offset = (pageNo - 1) * ITEMS_PER_SHEET;
    for (let i = 0; i < ITEMS_PER_SHEET; i += 1) {
      const item = items[offset + i] || {};
      front.push({
        h: ROW_H.detail,
        cells: [
          txt(DETAIL_COLS.part, text(item.part)),
          txt(DETAIL_COLS.name, text(item.name), { left: true }),
          txt(DETAIL_COLS.surveyQty, num(item.surveyQty)),
          txt(DETAIL_COLS.actualQty, num(item.actualQty)),
          txt(DETAIL_COLS.actualHours, num(item.actualHours)),
          txt(DETAIL_COLS.measureQty, num(item.measureQty)),
          txt(DETAIL_COLS.quotaCode, text(item.quotaCode), { fs: 'code' }),
          txt(DETAIL_COLS.quotaHours, num(item.quotaHours)),
          txt(DETAIL_COLS.laborFee, yuan(item.laborFeeCents)),
          txt(DETAIL_COLS.materialFee, yuan(item.materialFeeCents)),
          txt(DETAIL_COLS.quality, text(item.quality)),
          txt(0, text(item.note), { fs: 'note' }),
        ],
      });
    }
    front.push({
      h: ROW_H.footer,
      cells: [
        lb(FOOTER.fillerLabel, vertical('填单人')),
        signCell(FOOTER.fillerValue, 'filler', order, 'fillerSignUrl', 'fillerName', target, draft),
        lb(FOOTER.repairerLabel, vertical('修理人')),
        signCell(FOOTER.repairerValue, 'repairer', order, 'repairerSignUrl', 'repairerName', target, draft),
        lb(FOOTER.inspectorLabel, vertical('查验员')),
        signCell(FOOTER.inspectorValue, 'inspector', order, 'inspectorSignUrl', 'inspectorName', target, draft, 'inspector'),
        { w: FOOTER.quotaFeeLabel, kind: 'vpair' },
        { w: FOOTER.total, kind: 'total', txt: isLast ? yuan(order.totalCents) : '' },
        { w: 0, kind: 'voucher', txt: text(order.voucherIssue) },
      ],
    });

    // ---------- 存根「报修凭证」 ----------
    const reported = ymd(order.reportedOn);
    const stub: SheetRow[] = [
      { h: STUB_ROWS[0], cells: [lb(STUB_LABEL_NARROW, '报修\n日期'), { w: 0, kind: 'ymd', ...reported }] },
      { h: STUB_ROWS[1], cells: [lb(STUB_LABEL_WIDE, '报修人\n姓名'), txt(0, text(order.reporterName))] },
      { h: STUB_ROWS[2], cells: [lb(STUB_LABEL_NARROW, '报修\n部位'), txt(0, text(order.faultPart))] },
      { h: STUB_ROWS[3], cells: [lb(0, '报 修 项 目')] },
      { h: STUB_ROWS[4], cells: [txt(0, text(order.repairItem), { left: true })] },
      { h: STUB_ROWS[5], cells: [{ w: 0, kind: 'empty' }] },
      { h: STUB_ROWS[6], cells: [{ w: 0, kind: 'empty' }] },
      { h: STUB_ROWS[7], cells: [{ w: 0, kind: 'empty' }] },
      { h: STUB_ROWS[8], cells: [{ w: 0, kind: 'empty' }] },
      { h: STUB_ROWS[9], cells: [lb(STUB_LABEL_WIDE, '填单人'), txt(0, text(order.fillerName))] },
    ];

    // ---------- 背面「材料领耗记录」左块 ----------
    const back: SheetRow[] = [];
    back.push({
      h: BACK_ROW_H.head,
      cells: [
        lb(BACK_COLS.name, '材料名称'),
        lb(BACK_COLS.spec, '规格'),
        lb(BACK_COLS.unit, '单位'),
        lb(BACK_COLS.estQty, '估料\n数量'),
        lb(BACK_COLS.pickQty, '领料\n数量'),
        lb(BACK_COLS.usedQty, '实耗\n数量'),
        lb(BACK_COLS.returnQty, '退料\n数量'),
        lb(BACK_COLS.amount, '实耗\n金额'),
        lb(0, '备 注'),
      ],
    });
    const mOffset = (pageNo - 1) * MATERIALS_PER_SHEET;
    for (let i = 0; i < MATERIALS_PER_SHEET; i += 1) {
      const row = materials[mOffset + i] || {};
      back.push({
        h: BACK_ROW_H.detail,
        cells: [
          txt(BACK_COLS.name, text(row.name), { left: true }),
          txt(BACK_COLS.spec, text(row.spec), { fs: 'spec' }),
          txt(BACK_COLS.unit, text(row.unit), { fs: 'spec' }),
          txt(BACK_COLS.estQty, num(row.estQty)),
          txt(BACK_COLS.pickQty, num(row.pickQty)),
          txt(BACK_COLS.usedQty, num(row.usedQty)),
          txt(BACK_COLS.returnQty, num(row.returnQty)),
          txt(BACK_COLS.amount, yuan(row.amountCents)),
          txt(0, text(row.note), { left: true, fs: 'note' }),
        ],
      });
    }
    back.push({ h: BACK_ROW_H.service, cells: [lb(BACK_COLS.name, '服务记录'), txt(0, text(order.serviceRecord), { left: true })] });
    back.push({ h: BACK_ROW_H.followUp, cells: [lb(BACK_COLS.name, '回访记录'), txt(0, text(order.followUpRecord), { left: true })] });

    pages.push({
      no,
      noLong: no.length > 8,
      pageMark,
      unitName: text(order.unitName),
      front,
      stub,
      back,
      scrap: text(order.scrapNote),
      materialTotal: isLast ? yuan(order.materialTotalCents) : '',
    });
  }
  return pages;
}
