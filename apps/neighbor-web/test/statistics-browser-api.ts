// Synthetic-only transport for the statistics regression fixture.
// Every unexpected call fails closed: this fixture never reaches a real server.
const w = window as any;
w.__calls = [];
w.__annualFail = false;
w.__annualUnavailable = false;
w.__optionsUnavailable = false;
w.__detailFail = false;
w.__billsFail = false;
w.__blobs = [];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OFFICES = [
  { officeCode: '01', name: '枫桦景苑一期', communityId: 1, communityName: '枫桦景苑一期' },
  { officeCode: '02', name: '枫桦景苑二期A', communityId: 2, communityName: '枫桦景苑二期' },
  { officeCode: '03', name: '枫桦景苑二期B', communityId: 2, communityName: '枫桦景苑二期' },
  { officeCode: '04', name: '上海新家', communityId: 16, communityName: '上海新家' },
];
// 旧 MIS 收费项目分类树：代收费 / 其它 / 日常收费 / 停车收费（后端 P1.2 在 feeItems 里带 category）。
const FEE_ITEMS = [
  { code: '01', name: '管理费', category: '日常收费' },
  { code: '02', name: '租金', category: '日常收费' },
  { code: '03', name: '保洁保安费', category: '日常收费' },
  { code: '04', name: '泊位费', category: '停车收费' },
  { code: '05', name: '临时停车费', category: '停车收费' },
  { code: '06', name: '保安费', category: '日常收费' },
  { code: '07', name: '保洁费', category: '日常收费' },
  { code: '08', name: '保安保洁费', category: '日常收费' },
  { code: '09', name: '网络费', category: '其它' },
  { code: '10', name: '青客租金', category: '其它' },
  { code: '11', name: '青客未签约租金', category: '其它' },
  { code: '12', name: '水费', category: '代收费' },
  { code: '13', name: '电费', category: '代收费' },
  { code: '14', name: '停车管理费', category: '停车收费' },
  { code: '15', name: '空房租金', category: '日常收费' },
  { code: '16', name: '置业泊位费', category: '停车收费' },
];
// MIS FWXZK 房屋性质字典（outputs/mis-db-sync-20261106/data/0043_dbo.FWXZK.csv，01–13 共 13 项）。
const NATURES = [
  { code: '01', name: '商品房' }, { code: '02', name: '售后公房' }, { code: '03', name: '使用权房' },
  { code: '04', name: '商铺' }, { code: '05', name: '配套用房' }, { code: '06', name: '空房' },
  { code: '07', name: '居住' }, { code: '08', name: '非居住' }, { code: '09', name: '系统' },
  { code: '10', name: '非系统' }, { code: '11', name: '代管' }, { code: '12', name: '非代管' },
  { code: '13', name: '私房' },
];
const OPTIONS = {
  offices: OFFICES,
  feeItems: FEE_ITEMS,
  natures: NATURES,
  yearRange: { min: 2004, max: 2027 },
  dataAsOf: '2026-11-09T21:00:00+08:00',
  sourceMode: 'mirror',
  available: true,
  message: null as string | null,
};

// 验收基准：02 管理处管理费欠费 2011=921.00 / 2012=307.00 / 2014=477.90 / 2025=16,595.00 / 2026=726,881.20
const ARREARS_CELLS: Record<string, Record<number, number>> = {
  '01': { 2014: 100000 },
  '02': { 2011: 92100, 2012: 30700, 2014: 47790, 2025: 1659500, 2026: 72688120 },
  '04': { 2020: 5000 },
};
const RECEIVED_CELLS: Record<string, Record<number, number>> = {
  // P1.3：实收按「应收年月」归年；01 管理处 2004 应收年度 ¥982.40（含 06 空房 ¥100.00，
  // 收款项在 2006/2009/2013 收回，验证跨年）。
  // 旧系统实收报表不按应收截止年月截断：2027 列仍有金额（¥1,600.00）。
  '01': { 2004: 98240, 2027: 160000 },
  '02': { 2014: 120000, 2025: 16595000, 2026: 726881200 },
};

/** 实收 01×2004 的 23 条逐笔已收流水，合计 98240 分（含 06 空房 ¥100.00，与单元格一致）。 */
function received2004Rows() {
  const count = 23;
  const total = 98240;
  const base = 3600;
  return Array.from({ length: count }, (_, index) => {
    const last = index === count - 1;
    const paidYears = ['2006-03-15', '2009-07-01', '2013-11-20'];
    return {
      zjId: 2004000 + index + 1,
      sId: 800 + index,
      address: `宝秀路${719 + index}号${101 + index}室`,
      ownerName: `合成业主${index + 1}`,
      areaSqm: 79.67,
      period: `2004${String((index % 12) + 1).padStart(2, '0')}`,
      amountCents: last ? total - base * (count - 1) : base,
      paidDate: paidYears[index % paidYears.length],
      refundDate: null,
      paymentMethod: index % 2 ? '银行' : '现金',
      cashier: '合成收费员',
      receiptNo: null,
      invoiceNo: null,
    };
  });
}

function receivedCellCents(officeCode: string, year: number): number {
  return RECEIVED_CELLS[officeCode]?.[year] ?? 0;
}

function annualResponse(type: string, officeCodes: string[], yearFrom: number, yearTo: number) {
  const columns: number[] = [];
  for (let year = yearFrom; year <= yearTo; year += 1) columns.push(year);
  const source = type === 'arrears' ? ARREARS_CELLS : RECEIVED_CELLS;
  const selected = officeCodes.length ? OFFICES.filter((office) => officeCodes.includes(office.officeCode)) : OFFICES;
  const rows = selected.map((office) => {
    const cells: Record<string, number> = {};
    for (const year of columns) cells[String(year)] = source[office.officeCode]?.[year] ?? 0;
    const totalCents = columns.reduce((sum, year) => sum + cells[String(year)], 0);
    return { officeCode: office.officeCode, officeName: office.name, cells, totalCents };
  });
  const subtotalCells: Record<string, number> = {};
  for (const year of columns) subtotalCells[String(year)] = rows.reduce((sum, row) => sum + row.cells[String(year)], 0);
  const subtotal = {
    cells: subtotalCells,
    totalCents: columns.reduce((sum, year) => sum + subtotalCells[String(year)], 0),
  };
  return { type, columns, rows, subtotal, dataAsOf: OPTIONS.dataAsOf, available: true, message: null };
}

export async function request<T>(options: any): Promise<T> {
  w.__calls.push({ url: options.url, method: options.method ?? 'GET', query: options.query ?? null, at: Date.now() });
  await pause(20);

  if (options.url === '/statistics/options') {
    if (w.__optionsUnavailable) {
      return { ...OPTIONS, available: false, message: 'MIS 镜像尚未完成首次同步（合成）' } as T;
    }
    return OPTIONS as T;
  }

  if (options.url === '/statistics/annual') {
    if (w.__annualFail) throw Error('统计读取失败：MIS 镜像暂不可用（合成）');
    const type = options.query?.type === 'arrears' ? 'arrears' : 'received';
    if (w.__annualUnavailable) {
      return {
        type, columns: [], rows: [], subtotal: null, dataAsOf: OPTIONS.dataAsOf,
        available: false, message: 'MIS 镜像本期未同步（合成）',
      } as T;
    }
    const officeCodes = String(options.query?.officeCodes ?? '').split(',').filter(Boolean);
    const yearFrom = Number(options.query?.yearFrom ?? OPTIONS.yearRange.min);
    const yearTo = Number(options.query?.yearTo ?? OPTIONS.yearRange.max);
    return annualResponse(type, officeCodes, yearFrom, yearTo) as T;
  }

  if (options.url === '/statistics/annual/detail') {
    if (w.__detailFail) throw Error('房屋明细读取失败（合成）');
    const officeCode = String(options.query?.officeCode ?? '');
    const year = Number(options.query?.year ?? 0);
    const type = options.query?.type === 'arrears' ? 'arrears' : 'received';
    if (type === 'received') {
      // P1.3：实收下钻直接是逐笔清单（detailKind:'received'），合计必须等于单元格。
      const rows = officeCode === '01' && year === 2004
        ? received2004Rows()
        : [{
          zjId: 9000 + year, sId: 900, address: `合成地址 ${officeCode} ${year}`, ownerName: '合成业主',
          areaSqm: 88.8, period: `${year}06`, amountCents: receivedCellCents(officeCode, year) || 10000,
          paidDate: `${year}-06-15`, refundDate: null, paymentMethod: '现金', cashier: '合成收费员',
          receiptNo: null, invoiceNo: null,
        }];
      const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
      return { detailKind: 'received', rows, totalCents, count: rows.length, available: true, message: null } as T;
    }
    const rows = officeCode === '02' && year === 2014
      ? [{
        sId: 719, address: '宝秀路719号719', ownerName: '合成业主', areaSqm: 79.67,
        periodRange: '201410-201412',
        amountCents: 47790,
      }]
      : [{
        sId: Number(`${officeCode || 9}${year}`), address: `合成地址 ${officeCode} ${year}`, ownerName: '合成业主',
        areaSqm: 88.8, periodRange: `${year}01-${year}12`, amountCents: 10000,
      }];
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    return { detailKind: 'arrears', rows, totalCents, available: true, message: null } as T;
  }

  if (options.url === '/statistics/annual/detail/bills') {
    if (w.__billsFail) throw Error('逐笔账单读取失败（合成）');
    const rows = ['202410', '202411', '202412'].map((period, index) => ({
      zjId: index + 1, feeCode: '01', feeName: '管理费', period, amountCents: 15930,
      paidDate: null, refundDate: null, paymentMethod: null, cashier: null,
    }));
    return { rows, totalCents: 47790 } as T;
  }

  throw Error('Unhandled synthetic request ' + String(options.url));
}

// 统计页只用到 request；其余导出仅为兼容可能的公共模块静态导入。
export const configure = () => undefined;
export const auth = { me: async () => ({}), getToken: () => undefined };
export const notifications = { unreadCount: async () => ({ count: 0 }) };
export const address = { tree: async () => [] };
export const accessCardIssuance = { readiness: async () => ({}) };
