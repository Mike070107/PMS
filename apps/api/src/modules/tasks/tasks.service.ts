import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RepairsService } from '../repairs/repairs.service';
import { QrLoginService } from '../auth/qr-login.service';

/** 系统定时任务（自动验收按租户配置；后续：SLA 提醒、账单生成、库存预警） */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly repairsService: RepairsService,
    private readonly qrLoginService: QrLoginService,
  ) {}

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
}
