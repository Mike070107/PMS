import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RepairsService } from '../repairs/repairs.service';
import { QrLoginService } from '../auth/qr-login.service';
import { AccessService } from '../access/access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ObservabilityService } from '../observability/observability.service';

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
  ) {}

  /** 每 5 分钟：聚合网站和小程序异常；同一问题一小时内只提醒一次。 */
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
            payload: { alertId: alert.id, source: alert.source },
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
