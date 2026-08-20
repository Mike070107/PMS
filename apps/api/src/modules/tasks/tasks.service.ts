import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RepairsService } from '../repairs/repairs.service';

/** 系统定时任务（自动验收按租户配置；后续：SLA 提醒、账单生成、库存预警） */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private readonly repairsService: RepairsService) {}

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
}
