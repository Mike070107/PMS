import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { ObservabilityService, clientIp, sourceFromRequest } from './observability.service';

const LOGIN_ACTIONS: Record<string, string> = {
  '/api/v1/auth/admin-login': 'web_password_login',
  '/api/v1/auth/qr-login/status': 'web_qr_login',
  '/api/v1/auth/oidc/status': 'external_access_login',
  '/api/v1/auth/staff-login': 'staff_miniapp_login',
  '/api/v1/auth/wx-login': 'owner_miniapp_login',
};

@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  constructor(private readonly observability: ObservabilityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: any }>();
    const res = context.switchToHttp().getResponse<Response>();
    const started = Date.now();
    const finish = (statusCode: number, result?: any, error?: any) => {
      const source = sourceFromRequest(req);
      const tenantId = req.user?.tenantId ?? numberOrNull(result?.user?.tenantId);
      const actorUserId = req.user?.id ?? numberOrNull(result?.user?.id);
      const capture = {
        tenantId,
        source,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode,
        durationMs: Date.now() - started,
        actorUserId,
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] || null,
        errorMessage: safeErrorMessage(error),
        body: req.body,
        result,
      };
      void this.observability.captureRequest(capture);

      const login = loginAttemptOf(req.originalUrl || req.url, result, statusCode, capture.errorMessage);
      if (login) {
        void this.observability.recordLogin({
          tenantId, source, action: login.action, success: login.success,
          actorUserId, account: String((req.body as any)?.account || '') || null,
          ipAddress: capture.ipAddress, userAgent: capture.userAgent,
          statusCode, durationMs: capture.durationMs, message: login.message,
        });
      } else if (shouldAuditOperation(req, actorUserId)) {
        void this.observability.recordOperation(capture);
      }
    };
    return next.handle().pipe(
      tap((result) => finish(res.statusCode || 200, result)),
      catchError((error) => {
        finish(Number(error?.getStatus?.() || error?.status || 500), undefined, error);
        return throwError(() => error);
      }),
    );
  }
}

export function loginAttemptOf(url: string, result: any, statusCode: number, errorMessage?: string | null): { action: string; success: boolean; message: string | null } | null {
  const path = String(url || '').split('?')[0];
  if (path.endsWith('/auth/qr-login/status')) {
    if (result?.status === 'confirmed') return { action: 'web_qr_login', success: true, message: null };
    if (result?.status === 'expired') return { action: 'web_qr_login', success: false, message: '微信登录票据无效或已过期' };
    if (result?.status === 'cancelled') return { action: 'web_qr_login', success: false, message: '微信登录已取消' };
    if (statusCode >= 400) return { action: 'web_qr_login', success: false, message: errorMessage || '微信登录票据无效' };
    return null; // pending/scanned 轮询不记失败，避免撞库告警被正常轮询刷屏
  }
  if (path.endsWith('/auth/oidc/status')) return result?.status === 'confirmed' ? { action: 'external_access_login', success: true, message: null } : null;
  const action = Object.entries(LOGIN_ACTIONS).find(([suffix]) => path.endsWith(suffix.replace('/api/v1', '')) || path.endsWith(suffix))?.[1];
  if (!action) return null;
  return { action, success: statusCode < 400, message: statusCode < 400 ? null : (errorMessage || '登录失败') };
}

function shouldAuditOperation(req: Request, actorUserId: number | null) {
  if (!actorUserId || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return false;
  const path = String(req.originalUrl || req.url).split('?')[0];
  return !path.includes('/observability/page-view')
    && !path.includes('/observability/client-errors')
    && !path.includes('/observability/feedback')
    && !path.includes('/auth/refresh')
    && !path.match(/\/notifications\/(read-all|\d+\/read)$/);
}

function safeErrorMessage(error: any) {
  const raw = Array.isArray(error?.response?.message) ? error.response.message.join('；') : error?.response?.message || error?.message;
  return raw ? String(raw).slice(0, 500) : null;
}

function numberOrNull(value: unknown) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
