import ExcelJS from 'exceljs';

/** 报表导出公共逻辑：把「汇总 + 明细」两类数据写成带表头的 xlsx；金额字段（*Cents）统一换算成元。 */
export interface ReportSheet {
  name: string;
  /** 汇总键值对，写在表头上面；金额字段同样按分转元 */
  meta?: Record<string, unknown>;
  rows: Record<string, unknown>[];
}

const LABELS: Record<string, string> = {
  from: '开始日期', to: '结束日期', granularity: '粒度', groupBy: '分组维度', range: '区间',
  total: '工单数', completed: '已完成', pendingReview: '待验收', cancelled: '已取消', active: '进行中', overdue: '超时',
  avgHours: '平均完成时长(小时)', feeCents: '收费', pendingFeeCents: '待验收收费', materialCostCents: '材料成本',
  avgRating: '平均评分', ratingCount: '评价数',
  netCents: '净收款', chargedCents: '收款', refundedCents: '退款', receiptCount: '收据数', houseCount: '收费户数', itemCount: '明细数',
  skuCount: 'SKU 数', warehouseCount: '仓库数', lowCount: '低于安全库存', totalQtyRows: '有库存行', totalAmountCents: '库存金额',
  lines: '领用行数', orders: '工单数', qty: '数量',
  key: '分组', label: '名称', day: '日期', bucket: '日期', method: '收款方式', feeCode: '费项编码', feeName: '费项',
  communityId: '小区ID', communityName: '小区', cashier: '收费员',
  userId: '员工ID', name: '姓名', phone: '电话', accountStatus: '账号状态', onDuty: '在岗', skills: '技能',
  skillLabels: '技能(中文)', canTakeOrders: '可接单', completedInRange: '区间完成', activeNow: '当前进行',
  warehouseId: '仓库ID', warehouseName: '仓库', materialName: '材料', stockQty: '当前库存', locationsText: '库位明细', updatedAt: '更新时间', warehouseType: '仓库类型', officeId: '管理处ID',
  materialId: '物料ID', code: '编码', spec: '规格', category: '分类', unit: '单位', enabled: '启用',
  safetyQty: '安全库存', low: '低于安全', unitCostCents: '单位成本', stockAmountCents: '库存金额', costSource: '成本来源', stockId: '库存行ID',
  usedAt: '领用时间', workOrderId: '工单ID', orderNo: '工单号', status: '状态', statusLabel: '状态说明',
  assigneeId: '责任人ID', assigneeName: '责任人', amountCents: '金额', truncated: '是否截断',
};

function headerOf(key: string) {
  const label = LABELS[key] || key;
  return /Cents$/.test(key) ? label + '（元）' : label;
}
function valueOf(key: string, value: unknown) {
  if (value === null || value === undefined) return '';
  if (/Cents$/.test(key) && typeof value === 'number') return Math.round(value) / 100;
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'object') return JSON.stringify(value);
  return value as string | number | boolean;
}

/** 生成 xlsx buffer。空数据也会保留表头，方便财务直接拿去补数。 */
export async function buildReportWorkbook(sheets: ReportSheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PMS';
  workbook.created = new Date();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    let rowCursor = 1;
    if (sheet.meta && Object.keys(sheet.meta).length) {
      ws.getCell(rowCursor, 1).value = '项目';
      ws.getCell(rowCursor, 2).value = '值';
      ws.getRow(rowCursor).font = { bold: true };
      rowCursor += 1;
      for (const [key, value] of Object.entries(sheet.meta)) {
        ws.getCell(rowCursor, 1).value = LABELS[key] || key;
        ws.getCell(rowCursor, 2).value = valueOf(key, value) as ExcelJS.CellValue;
        rowCursor += 1;
      }
      rowCursor += 1;
    }
    if (sheet.rows.length) {
      const keys: string[] = [];
      for (const row of sheet.rows) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
      const header = ws.getRow(rowCursor);
      keys.forEach((key, index) => { header.getCell(index + 1).value = headerOf(key); });
      header.font = { bold: true };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F8' } };
      const headerRow = rowCursor;
      rowCursor += 1;
      for (const row of sheet.rows) {
        const target = ws.getRow(rowCursor);
        keys.forEach((key, index) => { target.getCell(index + 1).value = valueOf(key, row[key]) as ExcelJS.CellValue; });
        rowCursor += 1;
      }
      keys.forEach((key, index) => {
        const width = /Cents$/.test(key) ? 14 : 12;
        ws.getColumn(index + 1).width = width;
        if (/Cents$/.test(key)) ws.getColumn(index + 1).numFmt = '#,##0.00';
        ws.getColumn(index + 1).alignment = { vertical: 'middle' };
      });
      ws.views = [{ state: 'frozen', ySplit: headerRow }];
      ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: keys.length } };
    } else {
      ws.getCell(rowCursor, 1).value = '该筛选范围暂无数据';
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
