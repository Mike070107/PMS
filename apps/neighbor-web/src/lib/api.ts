import { configure, request, ApiError } from '@pms/api-client';
import { auth } from './auth';

/** 与正式后台同一个后端、同一套接口；只是界面换了。 */
export function configureApi() {
  configure({
    baseURL: import.meta.env.VITE_API_BASE_URL || '/api/v1',
    getToken: () => auth.getToken(),
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
      if (!window.location.pathname.endsWith('/login')) {
        const base = import.meta.env.BASE_URL.replace(/\/$/, '');
        window.location.replace(`${base}/login`);
      }
    },
  });
}

export { request, ApiError };
