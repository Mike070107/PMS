import { auth } from './auth';

const API = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || '/api/v1';

export interface OfficeIntakePayload {
  operationKey: string;
  expectedVersion: number;
  confirm: boolean;
  plate?: string;
  contactName?: string;
  contactPhone?: string;
  relation?: string;
  garages?: string[];
  garageNumbers?: Record<string, string>;
  registrationTerm?: unknown;
  keepFileIndexes?: number[];
}

/** 办公室代填：登录态 + 权限头，走 /vehicle-intakes/:id/office，不是业主无登录接口。 */
export async function saveOfficeIntake(id: number, payload: OfficeIntakePayload, files: File[], signal?: AbortSignal): Promise<unknown> {
  const form = new FormData();
  form.append('data', JSON.stringify(payload));
  files.forEach(file => form.append('file', file, file.name || 'photo.jpg'));
  const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const tenant = auth.getActingTenant();
  if (tenant) headers['x-acting-tenant-id'] = String(tenant.id);
  const office = auth.getActingOffice();
  if (office) headers['x-acting-office-id'] = String(office.id);
  const res = await fetch(`${API}/vehicle-intakes/${id}/office`, { method: 'POST', body: form, headers, signal });
  const body = await res.json().catch(() => null) as { message?: string | string[]; error?: string } | null;
  if (!res.ok) {
    const raw = body?.message ?? body?.error;
    throw new Error(Array.isArray(raw) ? raw.join('；') : raw || `保存失败（HTTP ${res.status}）`);
  }
  return body;
}

/** 每次保存一个独立操作编号：网络超时后重试原请求不会重复计版本。 */
export function newOfficeKey() {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? `${Date.now()}${Math.random()}`.replace(/\D/g, '').slice(0, 32);
}
