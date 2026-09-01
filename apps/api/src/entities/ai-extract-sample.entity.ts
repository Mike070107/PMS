import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 一句话报修的「识别样例」：这句话**应该**认成什么。
 *
 * 为什么要这张表：提示词里的例子写死在代码里的话，每遇到一种新说法都得改代码、
 * 重新发版，办公室只能来找开发（2026-09-01 用户原话：「避免又要跟他说一遍
 * 遇到的规则怎么识别」）。放进库里之后，谁都可以在后台加一条
 * 「这么说 → 应该这么认」，下一次调用就带上了，不用发版。
 *
 * 用法是 few-shot：服务端拼提示词时把启用的样例按更新时间取最近若干条附在后面。
 * **不是训练**，是每次调用都把这些例子给模型看 —— 所以条数要克制，见
 * RepairTextAiService.SAMPLE_LIMIT：太多会让每次调用都变长、变慢、变贵。
 *
 * expected 里只放模型该输出的那几样；房号仍然要回房产库撞，样例不能让模型跳过撞库。
 */
@Entity('ai_extract_samples')
@Index(['tenantId', 'kind', 'enabled'])
export class AiExtractSample extends TenantEntity {
  /**
   * 这条样例教的是哪件事：
   *   repair     一句话报修（原话 → 地址/故障/联系人）
   *   completion 完工小结（维修工说一句 → 维修说明/故障位置/现象）
   * 两边的提示词各取各的，别混着教 —— 报修的例子会把完工那边带偏。
   */
  @Column({ type: 'varchar', length: 20, default: 'repair' })
  kind: string;

  /** 原话。就是维修工/业主实际会说出口的那一句 */
  @Column({ type: 'text' })
  text: string;

  /**
   * 期望的识别结果，字段和 RepairTextAiResult 对齐：
   * { addressText, description, contactName, phone, urgent, publicArea, repairType }
   * 只填要教的那几个；留空的字段不会写进提示词，避免教出「什么都空」。
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  expected: Record<string, unknown>;

  /** 为什么加这一条（「语音把弄号断成了两段」），给后来的人看，不进提示词 */
  @Column({ type: 'varchar', length: 200, default: '' })
  note: string;

  /** 关掉 = 暂时不带进提示词，但记录留着（教错了先关掉，不用删） */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;
}
