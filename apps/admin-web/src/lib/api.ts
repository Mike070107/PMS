import { configure, request, ApiError } from '@pms/api-client';
import { auth } from './auth';

export function configureApi() {
  configure({
    baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1',
    getToken: () => auth.getToken(),
    // 平台超管进入公司视角后，所有请求都以该公司身份运作；
    // 管理处视角只收窄数据范围，无效值后端会静默忽略
    getExtraHeaders: (): Record<string, string> => {
      const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
      const acting = auth.getActingTenant();
      if (acting) headers['x-acting-tenant-id'] = String(acting.id);
      const office = auth.getActingOffice();
      if (office) headers['x-acting-office-id'] = String(office.id);
      return headers;
    },
    onUnauthorized: () => {
      auth.clear();
      if (window.location.pathname !== '/login') {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`/login?next=${next}`);
      }
    },
  });
}

export { request, ApiError };
