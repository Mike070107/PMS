import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class GrantSubscribeDto {
  /** 用户点了「允许」的模板 id；一次弹窗最多 3 个，这里放宽到 10 */
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  templateIds: string[];
}

const TEMPLATE_KEYS = ['orderDispatched', 'orderReview', 'orderAssigned'] as const;

export class TemplateCheckDto {
  @IsIn(TEMPLATE_KEYS)
  template: (typeof TEMPLATE_KEYS)[number];

  /** 没保存也能先校验：传当前输入框里的值 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  templateId?: string;
}

export class TemplateTestDto {
  @IsIn(TEMPLATE_KEYS)
  template: (typeof TEMPLATE_KEYS)[number];
}
