import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class GrantSubscribeDto {
  /** 用户点了「允许」的模板 id；一次弹窗最多 3 个，这里放宽到 10 */
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  templateIds: string[];
}

/**
 * 可推的订阅消息模板。**这里是唯一来源** —— 校验白名单和 SubscribeTemplateKey 都从它派生。
 *
 * 放在 dto 而不是 service：`@IsIn()` 在类定义时就求值，万一哪天 service 反向 import dto
 * 形成循环，这个数组会变成 undefined、校验静默失效。dto 只依赖 class-validator，永远先加载完。
 *
 * 2026-08-30 踩过：service 里有 5 个 key、后台设置页也渲染了 5 行，这里却只抄了 3 个 ——
 * 「办公室催修」和「超时没人接单」点校验/发送测试一律 400
 * `template must be one of the following values`。新增模板只改这一处，别再抄第二份。
 */
export const SUBSCRIBE_TEMPLATE_KEYS = [
  'orderDispatched',
  'orderReview',
  'orderAssigned',
  'orderOverdue',
  'orderUrge',
] as const;

export type SubscribeTemplateKey = (typeof SUBSCRIBE_TEMPLATE_KEYS)[number];

export class TemplateCheckDto {
  @IsIn(SUBSCRIBE_TEMPLATE_KEYS)
  template: SubscribeTemplateKey;

  /** 没保存也能先校验：传当前输入框里的值 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  templateId?: string;
}

export class TemplateTestDto {
  @IsIn(SUBSCRIBE_TEMPLATE_KEYS)
  template: SubscribeTemplateKey;
}
