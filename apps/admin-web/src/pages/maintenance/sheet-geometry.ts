/**
 * 纸面尺寸表。
 *
 * 下面除 `PAGE` 和 `TABLE_W` 外的每个数字，都量自实体单据的扫描件
 * （src/EPSON201.PDF：PDF 幅面 595×841pt = A4，图 2480×3507px，即 300dpi 1:1，
 * 像素 ÷ 11.81 = 毫米）。扫描件上整张纸是 211mm × 114.7mm，
 * 任务单表格 149.5mm × 84.5mm，存根表格 36.6mm。
 *
 * 纸张按用户实测的 227mm × 116mm 出。**长边比扫描件多 16mm**
 * （多半是骑缝/装订那条边，扫的那张已经撕掉了）—— 高度对得上（114.7 ≈ 116），
 * 所以只有横向要放大：所有横向尺寸乘 K = TABLE_W / 149.5，纵向原样用实测值。
 *
 * 要**套打**（打在预印好的联单上）时，把 TABLE_W 改成实体表格的实际宽度即可 ——
 * 版心位置、存根、骑缝线都跟着这一个数走，别处不用动。
 */

/** 纸张（用户实测） */
export const PAGE = { w: 227, h: 116 } as const;

/** 扫描件上任务单表格的真实宽度，换算比例的基准，别改 */
const SCAN_TABLE_W = 149.5;

/**
 * 渲染时任务单表格的宽度。
 * 160 = 扫描件的 149.5 等比放大到 227mm 纸上（× 1.0702），比例和纸上一致。
 * 套打时改成实体表格实测宽度。
 */
export const TABLE_W = 160;

/** 横向缩放系数：实测尺寸 → 渲染尺寸 */
const K = TABLE_W / SCAN_TABLE_W;

/** 实测毫米 → 渲染毫米（只用于横向） */
const x = (mm: number) => Math.round(mm * K * 100) / 100;
const xs = <T extends readonly number[]>(list: T) => list.map(x) as unknown as T;
const xp = (pairs: readonly (readonly [number, number])[]) =>
  pairs.map(([a, b]) => [x(a), x(b)] as const);

// ---------------- 版心位置（纸张上的横向布局） ----------------

/** 扫描件上：左边距 7.55 → 表格 → 8.7 的空当（中间是骑缝线）→ 存根 → 右边距 8.8 */
const SCAN_GAP = 8.7;
export const STUB_W = x(36.6);
const GAP = x(SCAN_GAP);
/** 内容整体居中摆在纸上，两边余量自然分配 */
export const MAIN_LEFT = Math.round(((PAGE.w - (TABLE_W + GAP + STUB_W)) / 2) * 100) / 100;
export const PERF_LEFT = Math.round((MAIN_LEFT + TABLE_W + GAP / 2) * 100) / 100;
export const STUB_LEFT = Math.round((MAIN_LEFT + TABLE_W + GAP) * 100) / 100;

// ---------------- 正面 ----------------

/** 行高（纵向不缩放，直接用实测值：9.15 / 8.98 / 7.03 / 8.21 / 9.82 / 7.1×4 / 12.79） */
export const ROW_H = {
  reporter: 9.15,
  part: 9,
  category: 7.05,
  checks: 8.2,
  detailHead: 9.85,
  detail: 7.15,
  footer: 12.8,
} as const;

/** 表头两行拆分（预算定额 / 编号·工时·人工费），实测各占一半 */
export const DETAIL_HEAD_SPLIT = { top: 4.9, bottom: 4.95 } as const;

/** 第 1 行：报修人姓名 | 值 | 地址 | 地址栏 | 报修日期 | 值 | 有人时间 | 值 | 报修人(户)验收 */
export const ROW1 = xs([14.3, 11.6, 9.5, 43.1, 9.6, 10.1, 9.6, 10.2, 31.5] as const);

/** 第 2 行：报修部位 | 值 | 报修项目 | 值 | 预约日期 | 值 | 开工日期 | 值 | 完工日期 | 值 | 验收签名 */
export const ROW2 = xs([
  14.4, 11.6, 9.6, 20.9, 10.2, 11.9, 9.7, 10.0, 9.7, 10.1, 31.4,
] as const);

/** 第 3 行：修缮日期（ ）| 费用类别（ ）| 分摊方式（ ） */
export const ROW3 = xs([49.7, 48.8, 51.0] as const);

/**
 * 第 4 行三组勾选，每组 [名称宽, 勾选框宽]。
 * 三组的分界和第 3 行的三格**并不对齐**（纸上就是错开的：43.1 / 63.2 / 43.2）。
 */
export const CHECK_GROUPS = {
  part: xp([
    [7.8, 6.7],
    [7.3, 6.7],
    [7.6, 7.0],
  ]),
  fee: xp([
    [7.5, 6.9],
    [7.6, 6.7],
    [10.5, 6.7],
    [10.3, 7.0],
  ]),
  share: xp([
    [7.2, 7.2],
    [7.5, 7.0],
    [7.1, 7.2],
  ]),
} as const;

/**
 * 明细表 12 列：
 * 查勘部位 | 查勘修理项目 | 查勘数量 | 实做数量 | 实做工时 | 量方数量 |
 * 编号 | 工时 | 人工费 | 材料费 | 质量验收 | 备注
 */
export const DETAIL_COLS = {
  part: x(10.0),
  name: x(32.8),
  surveyQty: x(10.0),
  actualQty: x(9.7),
  actualHours: x(9.6),
  measureQty: x(9.8),
  quotaCode: x(11.4),
  quotaHours: x(11.2),
  laborFee: x(11.5),
  materialFee: x(11.9),
  quality: x(10.3),
  note: x(11.3),
} as const;

/** 预算定额合并格宽度 = 编号 + 工时 + 人工费 */
export const QUOTA_GROUP_W =
  DETAIL_COLS.quotaCode + DETAIL_COLS.quotaHours + DETAIL_COLS.laborFee;

/** 页脚：填单人 | 签名 | 修理人 | 签名 | 查验员 | 签名 | 定额工料费 | 合计 | 凭证发放 */
export const FOOTER = {
  fillerLabel: x(6.8),
  fillerValue: x(19.6),
  repairerLabel: x(6.2),
  repairerValue: x(20.3),
  inspectorLabel: x(6.7),
  inspectorValue: x(22.4),
  quotaFeeLabel: x(11.3),
  total: x(22.7),
  voucher: x(33.5),
} as const;

/** 凭证发放格内部上下两段（纵向，不缩放） */
export const VOUCHER_SPLIT = { label: 6.6, value: 6.2 } as const;

/** 地址格四个槽的宽度（占地址格的百分比）；上行「村」的宽度 = 路 + 弄，正对着下行的「弄」 */
export const ADDR_SLOTS = { road: 27, lane: 20, buildingNo: 23, room: 25 } as const;

/** 「报修凭证」存根：10 行（纵向实测值） */
export const STUB_ROWS = [9.7, 9.7, 9.6, 7.8, 7.95, 7.95, 7.8, 7.8, 7.7, 8.9] as const;
/** 存根两种分栏：报修日期/报修部位用窄标签，报修人姓名/填单人用宽标签 */
export const STUB_LABEL_NARROW = x(10.6);
export const STUB_LABEL_WIDE = x(15.6);

/** 管房单位那条下划线：起点距表格左边、长度（横向缩放）；线与表格上沿留 1.5mm */
export const UNIT_LINE = { left: x(15.9), width: x(38.3), gapToTable: 1.5 } as const;

// ---------------- 背面《材料领耗记录》 ----------------

/** 左块 9 列（材料名称…备注），实测值 */
export const BACK_COLS = {
  name: x(18.3),
  spec: x(10.2),
  unit: x(10.1),
  estQty: x(12.4),
  pickQty: x(12.4),
  usedQty: x(12.3),
  returnQty: x(12.6),
  amount: x(12.4),
  note: x(22.6),
} as const;

/** 左块总宽（含备注列）与右侧「折旧料或整料记录」列宽 */
export const BACK_LEFT_W = x(123.3);
export const BACK_RIGHT_W = x(25.9);

/** 背面行高：表头 / 7 行材料 / 服务记录 / 回访记录（实测 9.14 / 8.44 / 8.30 / 8.38） */
export const BACK_ROW_H = { head: 9.15, detail: 8.45, service: 8.3, followUp: 8.4 } as const;

/** 右侧那一列自己分四段：表头 / 折旧料记录 / 材料合计 / 合计金额（实测 9.23 / 42.25 / 8.30 / 25.23） */
export const BACK_RIGHT = { head: 9.2, scrap: 42.2, totalLabel: 8.3 } as const;
