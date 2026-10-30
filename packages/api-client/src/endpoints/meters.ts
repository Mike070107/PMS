import { request } from '../request';

export type MeterType = 'water' | 'electricity' | 'gas' | 'heat';
export type MeterStatus = 'active' | 'disabled';
export type ReadingStatus = 'pending' | 'confirmed' | 'void';
export type ChargeStatus = 'unpaid' | 'partial' | 'paid' | 'void';

export interface MeterRow {
  id: number;
  meterNo: string;
  meterType: MeterType;
  meterTypeLabel: string;
  name: string;
  spec: string;
  manufacturer: string;
  model: string;
  multiplier: number;
  integerDigits: number;
  decimalDigits: number;
  unit: string;
  communityId: number | null;
  communityName: string;
  houseId: number | null;
  houseLabel: string;
  installAddress: string;
  latitude: number | null;
  longitude: number | null;
  ownerName: string;
  ownerPhone: string;
  unitPriceCents: number;
  unitPriceYuan: number;
  billingEnabled: boolean;
  initialReading: string | null;
  initialReadingAt: string | null;
  lastReadingValue: number | null;
  lastReadingValueText: string;
  lastReadingAt: string | null;
  lastUsage: number | null;
  readingCount: number;
  unpaidCents: number;
  status: MeterStatus;
  photoUrl: string;
  remark: string;
  qrToken: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeterListResp {
  rows: MeterRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: number; water: number; electricity: number; gas: number; heat: number };
}

export interface MeterReadingRow {
  id: number;
  meterId: number;
  meterNo: string;
  meterName: string;
  meterType: MeterType;
  meterTypeLabel: string;
  unit: string;
  readingValue: number;
  readingValueText: string;
  previousValue: number | null;
  usageValue: number | null;
  readAt: string;
  createdAt: string;
  source: 'photo' | 'manual' | 'import';
  photoUrl: string;
  photoKey: string | null;
  photoWidth: number | null;
  photoHeight: number | null;
  /** 端上框选的读数区域（0~1），后台据此在原图上画红框 */
  roi: { x: number; y: number; w: number; h: number } | null;
  /** OCR 自动选择的旋转角，原图不旋转 */
  orientation: number;
  ocrStatus: 'success' | 'failed' | 'skipped';
  ocrProvider: 'sidecar' | 'llm' | 'none' | null;
  ocrConfidence: string | null;
  ocrText: string;
  ocrMeterNo: string | null;
  status: ReadingStatus;
  anomalyFlags: string[];
  anomalyLabels: string[];
  latitude: number | null;
  longitude: number | null;
  gpsAccuracy: string | null;
  operatorId: number | null;
  operatorName: string;
  note: string;
  reviewNote: string;
  reviewedAt: string | null;
  chargeId: number | null;
  chargeStatus: ChargeStatus | null;
  receivableCents: number | null;
  paidCents: number | null;
}

export interface MeterChargeRow {
  id: number;
  meterId: number;
  readingId: number;
  meterNo: string;
  meterName: string;
  meterType: MeterType;
  meterTypeLabel: string;
  ownerName: string;
  period: string;
  usageValue: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  adjustmentCents: number;
  receivableCents: number;
  paidCents: number;
  outstandingCents: number;
  status: ChargeStatus;
  dueDate: string | null;
  paidAt: string | null;
  paymentMethod: string;
  receiptNo: string;
  note: string;
  createdAt: string;
}

export interface MeterDetailResp {
  meter: MeterRow;
  readings: MeterReadingRow[];
  charges: MeterChargeRow[];
  stats: { yearUsage: number; readingCount: number; unpaidCents: number };
  qrPayload: string;
}

export interface MeterOcrResp {
  ok: boolean;
  provider: 'sidecar' | 'llm' | 'none';
  value: number | null;
  digits: string | null;
  confidence: number;
  meterNo: string | null;
  meterNoCandidates: string[];
  meterNoMatched: boolean | null;
  texts: string;
  candidates: Array<{
    digits: string;
    value: number | null;
    score: number;
    text: string;
    explicitDecimal: boolean;
    box?: number[];
  }>;
  needsReview: boolean;
  imageUrl: string;
  orientation: number;
  error?: string;
}

export type OcrSampleStatus = 'candidate' | 'training' | 'trained' | 'excluded';

export interface OcrSampleRow {
  id: number;
  meterId: number;
  readingId: number | null;
  meterNo: string;
  meterName: string;
  meterType: MeterType;
  integerDigits: number;
  decimalDigits: number;
  photoUrl: string;
  roi: { x: number; y: number; w: number; h: number } | null;
  orientation: number;
  ocrProvider: string;
  ocrText: string;
  confidence: string | null;
  predictedValue: string | null;
  correctedValue: string | null;
  status: OcrSampleStatus;
  source: string;
  note: string;
  correctedAt: string | null;
  createdAt: string;
}

export interface OcrSampleListResp {
  rows: OcrSampleRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MeterSummaryResp {  period: string;
  meters: { total: number; active: number; due: number };
  readings: { readings: number; meters_read: number };
  usage: Array<{ meterType: MeterType; label: string; usage: number; unit: string }>;
  charges: { receivable: number; paid: number; outstanding: number; unpaid_count: number };
}

export interface MeterInput {
  meterNo: string;
  meterType: MeterType;
  name?: string;
  spec?: string;
  manufacturer?: string;
  model?: string;
  multiplier?: number;
  integerDigits?: number;
  decimalDigits?: number;
  unit?: string;
  communityId?: number;
  houseId?: number;
  installAddress?: string;
  latitude?: number;
  longitude?: number;
  ownerName?: string;
  ownerPhone?: string;
  unitPriceCents?: number;
  billingEnabled?: boolean;
  initialReading?: number;
  initialReadingAt?: string;
  status?: MeterStatus;
  photoUrl?: string;
  photoKey?: string;
  remark?: string;
  sortOrder?: number;
}

export interface ReadingInput {
  readingValue: number;
  readAt?: string;
  photoKey?: string;
  photoUrl?: string;
  photoWidth?: number;
  photoHeight?: number;
  roi?: { x: number; y: number; w: number; h: number };
  ocr?: {
    provider?: 'sidecar' | 'llm' | 'none';
    status?: 'success' | 'failed' | 'skipped';
    confidence?: number;
    text?: string;
    meterNo?: string;
    orientation?: number;
    raw?: Record<string, unknown>;
  };
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  clientRequestId?: string;
  note?: string;
  source?: 'photo' | 'manual' | 'import';
}

export interface ReadingResult {
  reading: MeterReadingRow;
  charge: MeterChargeRow | null;
  meter: MeterRow;
  usageLabel: string;
}

export interface ReadingListResp {
  rows: MeterReadingRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ChargeListResp {
  rows: MeterChargeRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: { receivable: number; paid: number; outstanding: number };
}

const query = (params: Record<string, string | number | boolean | undefined>) => params;

export const meters = {
  list: (params: {
    keyword?: string;
    meterType?: MeterType | '';
    status?: MeterStatus | '';
    communityId?: number;
    due?: boolean;
    page?: number;
    pageSize?: number;
  } = {}) =>
    request<MeterListResp>({
      url: '/meters',
      query: query({
        keyword: params.keyword,
        meterType: params.meterType || undefined,
        status: params.status || undefined,
        communityId: params.communityId || undefined,
        due: params.due ? '1' : undefined,
        page: params.page,
        pageSize: params.pageSize,
      }),
    }),

  summary: (period?: string) =>
    request<MeterSummaryResp>({ url: '/meters/summary', query: query({ period }) }),

  detail: (id: number) => request<MeterDetailResp>({ url: `/meters/${id}` }),

  lookup: (code: string) =>
    request<{ rows: MeterRow[] }>({ url: '/meters/lookup', query: query({ code }) }),

  create: (data: MeterInput) => request<MeterDetailResp>({ url: '/meters', method: 'POST', data }),

  update: (id: number, data: Partial<MeterInput>) =>
    request<MeterDetailResp>({ url: `/meters/${id}`, method: 'PUT', data }),

  remove: (id: number) => request<{ ok: boolean }>({ url: `/meters/${id}`, method: 'DELETE' }),

  qr: (id: number) =>
    request<{
      payload: string;
      dataUrl: string;
      meterNo: string;
      shortCode: string;
    }>({ url: `/meters/${id}/qr` }),

  ocr: (id: number, data: { imageKey: string; crop?: { x: number; y: number; w: number; h: number }; roi?: { x: number; y: number; w: number; h: number } }) =>
    request<MeterOcrResp>({ url: `/meters/${id}/ocr`, method: 'POST', data, timeout: 90000 }),

  ocrHealth: () =>
    request<{ ok: boolean; provider: string; detail?: string }>({ url: '/meters/ocr/health' }),

  createReading: (id: number, data: ReadingInput) =>
    request<ReadingResult>({ url: `/meters/${id}/readings`, method: 'POST', data, timeout: 30000 }),

  readings: (params: {
    meterId?: number;
    meterType?: MeterType | '';
    status?: ReadingStatus | '';
    keyword?: string;
    dateFrom?: string;
    dateTo?: string;
    anomalyOnly?: boolean;
    page?: number;
    pageSize?: number;
  } = {}) =>
    request<ReadingListResp>({
      url: '/meters/readings',
      query: query({
        meterId: params.meterId,
        meterType: params.meterType || undefined,
        status: params.status || undefined,
        keyword: params.keyword,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        anomalyOnly: params.anomalyOnly ? '1' : undefined,
        page: params.page,
        pageSize: params.pageSize,
      }),
    }),

  reading: (id: number) => request<ReadingResult>({ url: `/meters/readings/${id}` }),

  updateReading: (
    id: number,
    data: { readingValue?: number; note?: string; reviewNote?: string; status?: ReadingStatus },
  ) => request<ReadingResult>({ url: `/meters/readings/${id}`, method: 'PUT', data }),

  reviewReading: (id: number, data: { readingValue?: number; reviewNote?: string }) =>
    request<ReadingResult>({ url: `/meters/readings/${id}/review`, method: 'POST', data }),

  ocrSamples: (params: {
    status?: OcrSampleStatus | '';
    meterType?: MeterType | '';
    keyword?: string;
    page?: number;
    pageSize?: number;
  } = {}) =>
    request<OcrSampleListResp>({
      url: '/meters/ocr-samples',
      query: query({
        status: params.status || undefined,
        meterType: params.meterType || undefined,
        keyword: params.keyword,
        page: params.page,
        pageSize: params.pageSize,
      }),
    }),

  updateOcrSample: (id: number, data: { status: OcrSampleStatus; note?: string }) =>
    request<OcrSampleRow>({ url: `/meters/ocr-samples/${id}`, method: 'PATCH', data }),

  charges: (params: {
    meterType?: MeterType | '';
    status?: ChargeStatus | '';
    keyword?: string;
    period?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    pageSize?: number;
  } = {}) =>
    request<ChargeListResp>({
      url: '/meters/charges',
      query: query({
        meterType: params.meterType || undefined,
        status: params.status || undefined,
        keyword: params.keyword,
        period: params.period,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        page: params.page,
        pageSize: params.pageSize,
      }),
    }),

  payCharge: (
    id: number,
    data: {
      amountCents?: number;
      method?: string;
      paidAt?: string;
      receiptNo?: string;
      note?: string;
    },
  ) => request<MeterChargeRow>({ url: `/meters/charges/${id}/pay`, method: 'POST', data }),

  adjustCharge: (id: number, data: { adjustmentCents: number; note?: string }) =>
    request<MeterChargeRow>({ url: `/meters/charges/${id}/adjust`, method: 'POST', data }),

  voidCharge: (id: number) =>
    request<MeterChargeRow>({ url: `/meters/charges/${id}/void`, method: 'POST' }),
};
