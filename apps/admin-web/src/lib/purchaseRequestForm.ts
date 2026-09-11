/**
 * 导出传统的《XX 区材料申购单》Excel（2026-09-11 Mike：办公室现在手填这张纸，
 * 系统里的采购申请要能一键下成同一张表，下下来直接用）。
 *
 * 纸面长这样（列宽、留白行数都照它来）：
 *   第 1 行  合并居中的大标题「上海新家　区材料申购单」
 *   第 2 行  左边「日期2026/9/11」，右边「申请人：苏静」
 *   第 3 行  表头 序号 / 材料名称 / 规格 / 申购量 / 备注
 *   第 4 行起 明细；不足 10 行的用带序号的空行补满，好让人手写补充
 *
 * 用 exceljs 不用 SheetJS：这张表的价值在边框和居中，社区版 SheetJS 写不了单元格样式，
 * 导出来是一张没框的表，打印出来不能看。exceljs 按需 import()，不进首屏包。
 */

export interface PurchaseFormItem {
  name: string;
  spec: string;
  /** 申购量；有单位就一起写进格子（纸面上写的是「3 只」，这张表没有合计行） */
  qty: number;
  unit: string;
  note: string;
  /** 来源工单号，跟在备注后面，采购能顺着查回去 */
  sourceOrderNo: string;
}

export interface PurchaseFormData {
  /** 标题里那个区/管理处名，取来源工单所在管理处 */
  areaName: string;
  /** 申请单号，写在页脚方便对账 */
  requestNo: string;
  applicantName: string;
  /** 申请日期，YYYY/M/D */
  dateText: string;
  /** 申请原因，有就写在表格下面一行 */
  reason: string;
  items: PurchaseFormItem[];
}

/** 纸面固定 10 行，明细多了就按明细行数走 */
const MIN_ROWS = 10;
const HEADERS = ['序号', '材料名称', '规格', '申购量', '备注'];

export async function downloadPurchaseRequestForm(data: PurchaseFormData): Promise<void> {
  const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'));
  const wb = new ExcelJS.Workbook();
  wb.creator = '邻修物业管理平台';
  wb.created = new Date();
  const ws = wb.addWorksheet('材料申购单', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  ws.columns = [
    { width: 8 },
    { width: 22 },
    { width: 30 },
    { width: 12 },
    { width: 28 },
  ];

  // ---- 标题 ----
  ws.mergeCells('A1:E1');
  const title = ws.getCell('A1');
  title.value = `${data.areaName || ''}　区材料申购单`;
  title.font = { name: '宋体', size: 18, bold: true };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 38;

  // ---- 日期 / 申请人 ----
  const meta = ws.getRow(2);
  meta.height = 26;
  const dateCell = ws.getCell('A2');
  dateCell.value = `日期${data.dateText}`;
  dateCell.font = { name: '宋体', size: 12 };
  dateCell.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.mergeCells('D2:E2');
  const applicant = ws.getCell('D2');
  applicant.value = `申请人：${data.applicantName || ''}`;
  applicant.font = { name: '宋体', size: 12 };
  applicant.alignment = { horizontal: 'right', vertical: 'middle' };

  // ---- 表格 ----
  const thin = { style: 'thin' as const, color: { argb: 'FF000000' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  const headerRow = ws.getRow(3);
  headerRow.height = 28;
  HEADERS.forEach((text, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = text;
    cell.font = { name: '宋体', size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = border;
  });

  const rowCount = Math.max(MIN_ROWS, data.items.length);
  for (let i = 0; i < rowCount; i += 1) {
    const item = data.items[i];
    const row = ws.getRow(4 + i);
    row.height = 24;
    const values: Array<string | number> = [
      i + 1,
      item?.name ?? '',
      item?.spec ?? '',
      item ? (item.unit ? `${item.qty}${item.unit}` : item.qty) : '',
      item ? [item.note, item.sourceOrderNo].filter(Boolean).join(' · ') : '',
    ];
    values.forEach((value, c) => {
      const cell = row.getCell(c + 1);
      cell.value = value === '' ? null : value;
      cell.font = { name: '宋体', size: 11 };
      // 序号和申购量居中，其余靠左；备注可能长，允许换行
      cell.alignment = {
        horizontal: c === 0 || c === 3 ? 'center' : 'left',
        vertical: 'middle',
        wrapText: c === 2 || c === 4,
      };
      cell.border = border;
    });
  }

  // ---- 表下面的申请原因和单号：纸面没有，但下下来要能对回系统里那张单 ----
  const footRow = 4 + rowCount;
  ws.mergeCells(`A${footRow}:E${footRow}`);
  const foot = ws.getCell(`A${footRow}`);
  foot.value = [data.reason ? `申请原因：${data.reason}` : '', `系统申请单号：${data.requestNo}`]
    .filter(Boolean)
    .join('　　');
  foot.font = { name: '宋体', size: 10, color: { argb: 'FF595959' } };
  foot.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  ws.getRow(footRow).height = 22;

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${`${data.areaName || ''}材料申购单_${data.requestNo}`.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 在部分浏览器上会让下载中断，挪到下一帧
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
