import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RepairsService } from '../repairs/repairs.service';
import { QrLoginService } from '../auth/qr-login.service';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ObservabilityService } from '../observability/observability.service';
import { MisMirrorService } from '../fees/mis-mirror.service';

/** 系统定时任务（自动验收按租户配置；后续：SLA 提醒、账单生成、库存预警） */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly repairsService: RepairsService,
    private readonly qrLoginService: QrLoginService,
    private readonly observability: ObservabilityService,
    private readonly notifications: NotificationsService,
    private readonly access: AccessService,
    private readonly misMirror: MisMirrorService,
  ) {}

  /** 每 5 分钟：增量同步 MIS 镜像；没有初始化的公司跳过（必须管理员手工全量重灌）。 */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncMisMirror() {
    try {
      const result = await this.misMirror.syncAll();
      if (result.rows) this.logger.log(`MIS mirror synced ${result.rows} bill rows`);
      for (const failure of result.failures || []) {
        // 每 5 分钟一轮，连续 3 次（约 15 分钟）才升级微信；成功会清零计数，不会持续刷屏。
        if (failure.consecutiveFailures !== 3) continue;
        const receivers = await this.access.userIdsWithPermission(failure.tenantId, 'logs', 'view');
        if (!receivers.length) continue;
        const now = new Date();
        const lastSync = failure.lastSuccessAt ? new Date(failure.lastSuccessAt) : null;
        const lagMinutes = lastSync ? Math.max(0, Math.round((now.getTime() - lastSync.getTime()) / 60_000)) : null;
        const content = `MIS 镜像增量同步已连续失败 3 次（约 15 分钟）。最后成功：${lastSync ? formatWxTime(lastSync) : '未知'}${lagMinutes === null ? '' : `（滞后 ${lagMinutes} 分钟）`}；错误：${failure.lastError.slice(0, 160)}`;
        for (const receiverId of receivers) {
          await this.notifications.notifyUser({
            tenantId: failure.tenantId,
            receiverId,
            eventKey: 'mis_mirror_sync_failed',
            title: 'MIS 镜像同步失败',
            payload: { content, consecutiveFailures: failure.consecutiveFailures, lastError: failure.lastError, lastSuccessAt: failure.lastSuccessAt },
            page: '/pages/messages/messages',
            template: 'orderOverdue',
            templateFields: {
              orderNo: `MIS-${now.getTime()}`,
              type: '系统告警',
              status: '镜像同步失败',
              statusShort: '失败',
              content,
              assignee: '系统管理员',
              address: 'MIS 镜像',
              reporter: '系统监控',
              time: formatWxTime(now),
              reportedAt: formatWxTime(now),
              dueAt: formatWxTime(now),
            },
          });
        }
      }
    } catch (err) {
      this.logger.error('syncMisMirror failed', err as Error);
    }
  }

  /** 每天：镜像 vs MIS 总量对账；差异写 system_logs。 */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async reconcileMisMirror() {
    try {
      const results = await this.misMirror.reconcileAll();
      const bad = results.filter((item) => !item.ok).length;
      if (bad) this.logger.warn(`MIS mirror reconciliation mismatch: ${bad}`);
    } catch (err) {
      this.logger.error('reconcileMisMirror failed', err as Error);
    }
  }

  /** 每 5 分钟：聚合网站和小程序异常；同一 fingerprint 6 小时内只提醒一次，恢复后重新计时。 */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectSystemAlerts() {
    try {
      const alerts = await this.observability.detectAlerts();
      for (const alert of alerts) {
        const receivers = await this.access.userIdsWithPermission(alert.tenantId, 'logs', 'view');
        const now = formatWxTime(new Date());
        for (const receiverId of receivers) {
          await this.notifications.notifyUser({
            tenantId: alert.tenantId,
            receiverId,
            eventKey: 'system_alert',
            title: alert.title,
            payload: {
              alertId: alert.id,
              source: alert.source,
              content: alert.message,
              requestPath: alert.requestPath ?? '',
              statusCode: alert.statusCode ?? null,
            },
            page: '/pages/messages/messages',
            // 先走服务号；未关注时复用员工端的催接单模板及其授权额度。
            template: 'orderOverdue',
            templateFields: {
              orderNo: `SYS-${alert.id}`,
              type: '系统异常',
              status: alert.title,
              statusShort: '有异常',
              content: alert.message,
              assignee: '系统管理员',
              address: sourceLabel(alert.source),
              reporter: '系统监控',
              time: now,
              reportedAt: now,
              dueAt: now,
            },
          });
        }
      }
      if (alerts.length) this.logger.warn(`emitted ${alerts.length} system alerts`);
    } catch (err) {
      this.logger.error('detectSystemAlerts failed', err as Error);
    }
  }

  /** 每小时：按各租户配置扫描超时待验收工单 */
  @Cron(CronExpression.EVERY_HOUR)
  async autoCompleteExpiredReviews() {
    try {
      const count = await this.repairsService.autoCompleteExpiredReviewsAllTenants();
      if (count > 0) {
        this.logger.log(
          `auto-completed ${count} work orders using tenant auto-review settings`,
        );
      }
    } catch (err) {
      this.logger.error('autoCompleteExpiredReviews failed', err as Error);
    }
  }

  /**
   * 每 10 分钟：派单后迟迟没人接的单，再催维修工一次并通知能派单的人。
   *
   * 10 分钟一轮是因为「派单后 60 分钟没接」这种阈值需要分钟级精度；
   * 每张单只催一次（工单上的 escalatedAt 打标记），不会因为扫得勤就催得勤。
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async escalateStaleDispatches() {
    try {
      const count = await this.repairsService.escalateStaleDispatchesAllTenants();
      if (count > 0) this.logger.log(`escalated ${count} unaccepted work orders`);
    } catch (err) {
      this.logger.error('escalateStaleDispatches failed', err as Error);
    }
  }

  /** 每天：清掉过期的扫码登录票据（两分钟就作废，留着只会把表撑大） */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpiredQrTickets() {
    try {
      const count = await this.qrLoginService.purgeExpired();
      if (count > 0) this.logger.log(`purged ${count} expired web login tickets`);
    } catch (err) {
      this.logger.error('purgeExpiredQrTickets failed', err as Error);
    }
  }

  /** 每天清理过期指标和日志：请求明细留 30 天，审计与异常留 180 天。 */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeObservabilityHistory() {
    try {
      const result = await this.observability.purgeExpired();
      if (result.metrics || result.logs) {
        this.logger.log(`purged ${result.metrics} request metrics and ${result.logs} system logs`);
      }
    } catch (err) {
      this.logger.error('purgeObservabilityHistory failed', err as Error);
    }
  }
}

function formatWxTime(value: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日 ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function sourceLabel(source: string) {
  return ({ 'admin-web': '管理后台', 'miniapp-staff': '员工端小程序', 'miniapp-owner': '业主端小程序' } as Record<string, string>)[source] || source;
}
