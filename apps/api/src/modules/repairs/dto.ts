import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsPhoneNumber,
  IsPositive,
  IsString,
  IsBoolean,
  MaxLength,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AiAssistTraceDto {
  @IsString()
  @MaxLength(1000)
  sourceText: string;

  @IsObject()
  draft: Record<string, unknown>;
}

export class CreateRepairRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  communityId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  houseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  addressText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  contactName?: string;

  @IsOptional()
  @IsPhoneNumber('CN')
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  repairType?: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  attachments?: string[];

  /**
   * 要求完成截止时间（办公室录入时勾选才填）。
   * 填了就用它，不填才落到报修类型规则里的默认时限。
   */
  @IsOptional()
  @IsDateString()
  slaDueAt?: string;
  /**
   * 端上自动判定的类型。人如果当场把它改成别的，两者就不一致 ——
   * 服务端据此落一条「负样本」（见 RepairTypeCorrection），
   * 让判定越用越准。不传 = 老版本端或没判出来。
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  predictedRepairType?: string;

  /**
   * 按紧急处理。端上从描述里认出「急修 / 加急 / 抢修」时会带 true 上来，
   * 人当场点掉就是 false —— 所以这里传了什么就听什么，不传才由服务端
   * 拿描述再判一次（老版本小程序、后台录入走的都是那条兜底）。
   */
  @IsOptional()
  @IsBoolean()
  urgent?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiAssistTraceDto)
  aiAssist?: AiAssistTraceDto;

  /** 只用于区分功能使用统计：随手拍 AI 入口 / 完整表单入口。 */
  @IsOptional()
  @IsIn(['quick_ai', 'form'])
  entryMode?: 'quick_ai' | 'form';
}

/** 管理员作废工单。确认字段防止前端误触或绕过二次确认。 */
export class VoidWorkOrderDto {
  @IsString()
  @MaxLength(500)
  reason: string;

  @IsBoolean()
  confirmReversal: boolean;
}

/** 随手拍：从描述文字里识别报修地址（「一期24号302」→ 库里真实的楼栋/房号） */
export class ParseRepairAddressDto {
  @IsString()
  @MaxLength(500)
  text: string;

  /** 报修人当前所在小区，用来在同名楼栋间优先选「他家附近」的那栋 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}

/** 设定/取消工单的要求完成截止时间；不传 slaDueAt = 取消 */
export class UpdateWorkOrderSlaDto {
  @IsOptional()
  @IsDateString()
  slaDueAt?: string;
}

/** 后台更正工单类型；learnKeywords 里的词同时写进新类型的判定关键词（自学习） */
export class UpdateWorkOrderRepairTypeDto {
  @IsString()
  @MaxLength(60)
  repairType: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  learnKeywords?: string[];
}

export class WorkOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  /**
   * 小程序端取数范围：
   * - mine：业主=我提交的报修；维修工=派给我的工单
   * - pool：工单池。维修工看管理处内所有未开工的单
   * - dispatch：派单台。只看既没有负责人、也没有候选维修工的待派单
   * 后台角色不传则为全部（仍受租户隔离）
   */
  @IsOptional()
  @IsIn(['mine', 'pool', 'dispatch', 'reported', 'all'])
  scope?: 'mine' | 'pool' | 'dispatch' | 'reported' | 'all';

  /**
   * 关键词：单号 / 报修地址 / 故障描述。
   * 办公室在派单台上查「上次那单谁修的」，只能靠这几样想起来，
   * 不给搜索就只能一页页翻（列表还截断在 100 条）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;
}

export class UpsertRepairTypeRuleDto {
  /** 归属管理处；不传 / null = 公司默认模板。改规则时忽略（归属不能改） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  officeId?: number | null;

  @IsString()
  @MaxLength(60)
  repairType: string;

  @IsString()
  @MaxLength(120)
  label: string;

  /** 兼容老后台：只传一个人。新后台传 assigneeIds */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assigneeId?: number | null;

  /** 默认维修工，可多人；不传 / 空数组 = 只进待派单 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  assigneeIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  slaHours?: number | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /**
   * 「猜你想输」常用词，按数组顺序展示。
   * 公司模板那一页 = 全公司通用的模板词；管理处那一页只有老后台才会传它，
   * 服务端当成本处增补收下（见 RepairsService.dtoSuggestions）。
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contentSuggestions?: string[];

  /** 管理处专用：本处自己加的词（模板词不用重复传） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraSuggestions?: string[];

  /** 管理处专用：本处停用的模板词 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mutedSuggestions?: string[];
}

/** 管理处的「猜你想输」口径开关 */
export class UpdateOfficeSuggestionSettingsDto {
  /** office_first = 本处优先（本处数据不足用全公司补齐）；company = 直接用全公司 */
  @IsOptional()
  @IsIn(['office_first', 'company'])
  suggestionScope?: 'office_first' | 'company';

  /** 本处归纳出的高频词要不要进公司模板的候选池 */
  @IsOptional()
  @IsBoolean()
  suggestionFeedback?: boolean;
}

export class ReorderRepairTypeRulesDto {
  @IsArray()
  @IsInt({ each: true })
  ids: number[];
}

export class AssignWorkOrderDto {
  @Type(() => Number)
  @IsInt()
  assigneeId: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  skill?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  slaHours?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/** 维修中的过程记录：文字、照片至少填一项。 */
export class AddWorkOrderProgressDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  attachments?: string[];
}

/** 维修工无法继续处理时，退回所属管理处重新分类和派单。 */
export class RequestWorkOrderTransferDto {
  @IsString()
  @MaxLength(500)
  note: string;
}

export class MaterialUsageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  materialId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @Type(() => Number)
  @IsPositive()
  qty: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  unitCostCents?: number;

  /**
   * 这一项用料的备注（「原件锈死一并换掉」之类）。
   * 会原样印到养护单背面《材料领耗记录》的备注格里，所以别写内部黑话。
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  note?: string;
}

export class CompleteWorkOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  faultLocation?: string;

  @IsOptional()
  @IsString()
  faultSymptom?: string;

  @IsOptional()
  @IsString()
  repairContent?: string;

  @IsOptional()
  @IsArray()
  actionTags?: string[];

  @IsOptional()
  @IsString()
  actionNote?: string;

  @IsOptional()
  @IsArray()
  resultAttachments?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  feeCents?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaterialUsageDto)
  materials?: MaterialUsageDto[];

  /** 只用于审计/学习；后端绝不据此覆盖 feeCents */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  feeRuleCode?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiAssistTraceDto)
  aiAssist?: AiAssistTraceDto;
}

export class MissingMaterialDto {
  /** 从材料库 SKU 选的才有；现场手填的留空，等办公室建完 SKU 再回来补关联 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  materialId?: number;

  /**
   * 这项材料是在哪个仓里判定为不足的。有 SKU 但本仓尚未管理时，
   * 服务端会建一条数量为 0 的仓库材料记录，不会再新建 SKU。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  warehouseId?: number;

  @IsString()
  @MaxLength(120)
  name: string;

  @Type(() => Number)
  @IsPositive()
  qty: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  estUnitCostCents?: number;
}

export class NeedMaterialDto {
  // 只写 @IsArray() 时嵌套对象既不校验也不过滤，[{}] 这种脏数据会原样落库，
  // 办公室汇总时就看到一行空材料。ValidateNested + Type 才会逐项校验并剔除多余字段。
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MissingMaterialDto)
  missingMaterials: MissingMaterialDto[];

  /**
   * 同一次选择里有库存的部分：先领用并记出库，缺口再进入采购。
   * 两部分由服务层放在同一事务里，任何一步失败都不会留下半套库存账。
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaterialUsageDto)
  usedMaterials?: MaterialUsageDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/** 办公室补建 SKU 后回来更正缺料清单（不新开采购申请，改的是同一张） */
export class UpdateMissingMaterialsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MissingMaterialDto)
  missingMaterials: MissingMaterialDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class CancelWorkOrderDto {
  /** 快选原因：wrong_info 填错了 / duplicate 重复提交 / self_resolved 已自行解决 / owner_cancel 业主取消 / other 其他 */
  @IsString()
  @MaxLength(30)
  reasonCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class ReviewWorkOrderDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @IsArray()
  attachments?: string[];
}
