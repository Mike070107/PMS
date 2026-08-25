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
