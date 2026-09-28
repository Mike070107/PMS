import type { ParsedRepairAddress } from '@pms/api-client/src/endpoints/repairs';

const STORAGE_KEY = 'pms:repair-form-handoff:v1';
const MAX_AGE_MS = 10 * 60 * 1000;

export interface RepairFormHandoff {
  content: string;
  sourceText: string;
  attachments: string[];
  detected: ParsedRepairAddress | null;
  specificLocation: string;
  contactName: string;
  contactPhone: string;
  repairType: string;
  urgent: boolean;
}

/**
 * 随手拍切到完整表单时不要继续把十几个字段塞进 URL。
 * 一次性交接草稿既避免 URL 截断，也保证地址 id、具体位置、联系人和原话来自同一版识别结果。
 */
export function saveRepairFormHandoff(value: RepairFormHandoff): void {
  wx.setStorageSync(STORAGE_KEY, { savedAt: Date.now(), value });
}

export function consumeRepairFormHandoff(): RepairFormHandoff | null {
  const stored = wx.getStorageSync(STORAGE_KEY) as
    | { savedAt?: number; value?: RepairFormHandoff }
    | undefined;
  wx.removeStorageSync(STORAGE_KEY);
  if (!stored?.value || !stored.savedAt || Date.now() - stored.savedAt > MAX_AGE_MS) return null;
  return stored.value;
}
