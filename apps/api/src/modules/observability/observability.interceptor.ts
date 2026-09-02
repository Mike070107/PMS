import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { ObservabilityService, clientIp, sourceFromRequest } from './observability.service';

const LOGIN_ACTIONS: Record<string, string> = {
  '/api/v1/auth/admin-login': 'web_password_login',
  '/api/v1/auth/qr-login/status': 'web_qr_login',
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
      };
      void this.observability.captureRequest(capture);

      const loginAction = loginActionOf(req.originalUrl || req.url, result);
      if (loginAction) {
        void this.observability.recordLogin({
          tenantId, source, action: loginAction, success: statusCode < 400,
          actorUserId, account: String((req.body as any)?.account || '') || null,
          ipAddress: capture.ipAddress, userAgent: capture.userAgent,
          statusCode, durationMs: capture.durationMs, message: capture.errorMessage,
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

function loginActionOf(url: string, result?: any) {
  const path = String(url || '').split('?')[0];
  if (path.endsWith('/auth/qr-login/status')) return result?.status === 'confirmed' ? 'web_qr_login' : null;
  return Object.entries(LOGIN_ACTIONS).find(([suffix]) => path.endsWith(suffix.replace('/api/v1', '')) || path.endsWith(suffix))?.[1] || null;
}

function shouldAuditOperation(req: Request, actorUserId: number | null) {
  if (!actorUserId || ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) return false;
  const path = String(req.originalUrl || req.url).split('?')[0];
  return !path.includes('/observability/page-view')
    && !path.includes('/observability/client-errors')
    && !path.includes('/auth/refresh')
    && !path.match(/\/notifications\/(read-all|\d+\/read)$/);
}

function safeErrorMessage(error: any) {
  const raw = Array.isArray(error?.response?.message) ? error.response.message.join('；') : error?.response?.message || error?.message;
  return raw ? String(raw).slice(0, 500) : null;
}

function numberOrNull(value: unknown) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }
