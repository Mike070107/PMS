import { auth } from './auth';

const API = import.meta.env.VITE_API_BASE_URL || '/api/v1';

/** 后端代理地址（私有桶直连地址取不到，存库与显示一律用它） */
export const uploadFileUrl = (objectKey: string) => `${API}/upload/file?key=${encodeURIComponent(objectKey)}`;

/** 浏览器上传一个文件到 /upload，返回可存库的代理地址 */
export async function uploadImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const acting = auth.getActingTenant();
  if (acting) headers['x-acting-tenant-id'] = String(acting.id);
  const res = await fetch(`${API}/upload`, { method: 'POST', body: fd, headers });
  let json: any = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error(json?.message || `上传失败（HTTP ${res.status}）`);
  const body = json && typeof json === 'object' && 'data' in json && json.data ? json.data : json;
  if (body?.objectKey) return uploadFileUrl(body.objectKey);
  if (body?.publicUrl || body?.displayUrl) return body.displayUrl || body.publicUrl;
  throw new Error('上传返回格式异常');
}
