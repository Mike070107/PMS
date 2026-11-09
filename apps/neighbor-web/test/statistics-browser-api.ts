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
const FEE_ITEMS = [
  { code: '01', name: '管理费' }, { code: '02', name: '租金' }, { code: '03', name: '保洁保安费' },
  { code: '04', name: '泊位费' }, { code: '05', name: '临时停车费' }, { code: '06', name: '保安费' },
  { code: '07', name: '保洁费' }, { code: '08', name: '保安保洁费' }, { code: '09', name: '网络费' },
  { code: '10', name: '青客租金' }, { code: '11', name: '青客未签约租金' }, { code: '12', name: '水费' },
  { code: '13', name: '电费' }, { code: '14', name: '停车管理费' }, { code: '15', name: '空房租金' },
  { code: '16', name: '置业泊位费' },
];
const NATURES = [
  { code: '01', name: '商品房' }, { code: '04', name: '配套用房' }, { code: '05', name: '商住' },
  { code: '06', name: '商铺' }, { code: '07', name: '居住' }, { code: '08', name: '非居住' },
];
const OPTIONS = {
  offices: OFFICES,
  feeItems: FEE_ITEMS,
  natures: NATURES,
  yearRange: { min: 2004, max: 2026 },
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
  '02': { 2014: 120000, 2025: 16595000, 2026: 726881200 },
};

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
    const rows = officeCode === '02' && year === 2014
      ? [{
        sId: 719, address: '宝秀路719号719', ownerName: '合成业主', areaSqm: 79.67,
        periodRange: type === 'arrears' ? '201410-201412' : '202401-202412',
        amountCents: type === 'arrears' ? 47790 : 120000,
      }]
      : [{
        sId: Number(`${officeCode || 9}${year}`), address: `合成地址 ${officeCode} ${year}`, ownerName: '合成业主',
        areaSqm: 88.8, periodRange: `${year}01-${year}12`, amountCents: 10000,
      }];
    const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    return { rows, totalCents } as T;
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
