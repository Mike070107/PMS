/**
 * 纸面尺寸表 2026-09-04 起搬到 packages/shared-types/src/maintenance-sheet-geometry.ts：
 * 员工端小程序的养护单预览要按同一张纸的格子画，两边各抄一份一定会跑偏。
 * 这里只做转发，原来的 import 路径不用改；要调尺寸去 shared-types 那份改。
 */
export {
  ADDR_SLOTS,
  BACK_COLS,
  BACK_LEFT_W,
  BACK_RIGHT,
  BACK_RIGHT_W,
  BACK_ROW_H,
  CHECK_GROUPS,
  DETAIL_COLS,
  DETAIL_HEAD_SPLIT,
  FOOTER,
  MAIN_LEFT,
  PAGE,
  PERF_LEFT,
  QUOTA_GROUP_W,
  ROW1,
  ROW2,
  ROW3,
  ROW_H,
  STUB_LABEL_NARROW,
  STUB_LABEL_WIDE,
  STUB_LEFT,
  STUB_ROWS,
  STUB_W,
  TABLE_W,
  UNIT_LINE,
  VOUCHER_SPLIT,
} from '@pms/shared-types';
