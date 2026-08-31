/**
 * 纸面尺寸表 —— 全部量自实体单据的 300dpi 扫描件（src/EPSON201.PDF，A4 幅面 2480×3507 =
 * 210×297mm，所以扫描件是 1:1，像素 ÷ 11.81 就是毫米）。
 *
 * 实测：整张纸 211mm × 114.7mm，任务单表格 149.5mm × 84.5mm，存根表格 36.6mm。
 * 用户给的纸张尺寸是 227mm × 116mm，比实测大 7.6%；页面按用户给的尺寸出，
 * 表格等比放大（× 160 / 149.5 = 1.0702），比例和纸上完全一致。
 * 将来要套打（打在预印好的联单上）就得按实测尺寸出一版，改这里一处即可。
 *
 * 下面的数字单位一律毫米，都是「放大到 160mm 表格」之后的值。
 */

/** 任务单表格总宽 */
export const TABLE_W = 160;

/** 行高（实测 9.15 / 8.98 / 7.03 / 8.21 / 9.82 / 7.1×4 / 12.79） */
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
export const ROW1 = [15.3, 12.4, 10.2, 46.1, 10.3, 10.8, 10.3, 10.9, 33.7] as const;

/** 第 2 行：报修部位 | 值 | 报修项目 | 值 | 预约日期 | 值 | 开工日期 | 值 | 完工日期 | 值 | 验收签名 */
export const ROW2 = [15.4, 12.4, 10.3, 22.4, 10.9, 12.7, 10.4, 10.7, 10.4, 10.8, 33.6] as const;

/** 第 3 行：修缮日期（ ）| 费用类别（ ）| 分摊方式（ ） */
export const ROW3 = [53.2, 52.2, 54.6] as const;

/**
 * 第 4 行三组勾选，每组 [名称宽, 勾选框宽]。
 * 注意：三组的分界和第 3 行的三格**并不对齐**（纸上就是错开的，量出来 46.1 / 67.6 / 46.3）。
 */
export const CHECK_GROUPS = {
  part: [
    [8.3, 7.2],
    [7.8, 7.2],
    [8.1, 7.5],
  ],
  fee: [
    [8.0, 7.4],
    [8.1, 7.2],
    [11.2, 7.2],
    [11.0, 7.5],
  ],
  share: [
    [7.7, 7.7],
    [8.0, 7.5],
    [7.6, 7.9],
  ],
} as const;

/**
 * 明细表 12 列：
 * 查勘部位 | 查勘修理项目 | 查勘数量 | 实做数量 | 实做工时 | 量方数量 |
 * 编号 | 工时 | 人工费 | 材料费 | 质量验收 | 备注
 */
export const DETAIL_COLS = {
  part: 10.7,
  name: 35.1,
  surveyQty: 10.7,
  actualQty: 10.4,
  actualHours: 10.3,
  measureQty: 10.5,
  quotaCode: 12.2,
  quotaHours: 12.0,
  laborFee: 12.3,
  materialFee: 12.7,
  quality: 11.0,
  note: 12.1,
} as const;

/** 预算定额合并格宽度 = 编号 + 工时 + 人工费 */
export const QUOTA_GROUP_W =
  DETAIL_COLS.quotaCode + DETAIL_COLS.quotaHours + DETAIL_COLS.laborFee;

/** 页脚：填单人 | 签名 | 修理人 | 签名 | 查验员 | 签名 | 定额工料费 | 合计 | 凭证发放 */
export const FOOTER = {
  fillerLabel: 7.3,
  fillerValue: 21.0,
  repairerLabel: 6.6,
  repairerValue: 21.7,
  inspectorLabel: 7.2,
  inspectorValue: 24.0,
  quotaFeeLabel: 12.1,
  total: 24.3,
  voucher: 35.8,
} as const;

/** 凭证发放格内部上下两段 */
export const VOUCHER_SPLIT = { label: 6.6, value: 6.2 } as const;

/** 地址格四个槽的宽度（占地址格的百分比）；上行「村」的宽度 = 路 + 弄，正对着下行的「弄」 */
export const ADDR_SLOTS = { road: 27, lane: 20, buildingNo: 23, room: 25 } as const;

/** 「报修凭证」存根：表格宽 39.2mm（实测 36.6mm × 1.0702），10 行 */
export const STUB_W = 39.2;
export const STUB_ROWS = [9.7, 9.7, 9.6, 7.8, 7.95, 7.95, 7.8, 7.8, 7.7, 8.9] as const;
/** 存根两种分栏：报修日期/报修部位用窄标签，报修人姓名/填单人用宽标签 */
export const STUB_LABEL_NARROW = 11.3;
export const STUB_LABEL_WIDE = 16.7;

/** 管房单位那条下划线：起点距表格左边 17mm、长 41mm，线与表格上沿之间留 1.5mm（实测） */
export const UNIT_LINE = { left: 17, width: 41, gapToTable: 1.5 } as const;

// ---------------- 背面《材料领耗记录》 ----------------

/** 左块 9 列（材料名称…备注），实测 149.2mm 等比放大到 160mm 后的值 */
export const BACK_COLS = {
  name: 19.6,
  spec: 10.9,
  unit: 10.8,
  estQty: 13.3,
  pickQty: 13.3,
  usedQty: 13.2,
  returnQty: 13.5,
  amount: 13.3,
  note: 24.2,
} as const;

/** 左块总宽（含备注列）与右侧「折旧料或整料记录」列宽 */
export const BACK_LEFT_W = 132.1;
export const BACK_RIGHT_W = 27.7;

/** 背面行高：表头 / 7 行材料 / 服务记录 / 回访记录（实测 9.14 / 8.44 / 8.30 / 8.38） */
export const BACK_ROW_H = { head: 9.15, detail: 8.45, service: 8.3, followUp: 8.4 } as const;

/** 右侧那一列自己分四段：表头 / 折旧料记录 / 材料合计 / 合计金额（实测 9.23 / 42.25 / 8.30 / 25.23） */
export const BACK_RIGHT = { head: 9.2, scrap: 42.2, totalLabel: 8.3 } as const;
