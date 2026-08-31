import { IsNull, Repository } from 'typeorm';
import { RepairTypeRule } from '../../entities';

/** 规则里的默认维修工：新字段优先，老数据只有 assignee_id 时兜底成单人数组 */
export function ruleAssigneeIds(rule: Pick<RepairTypeRule, 'assigneeId' | 'assigneeIds'>): number[] {
  if (rule.assigneeIds?.length) return rule.assigneeIds;
  return rule.assigneeId ? [rule.assigneeId] : [];
}

/**
 * 摊平了关键词三层来源的规则视图。
 *
 * 一律是**普通对象、不是实体**：contentSuggestions 在这里已经被换成了「生效关键词」，
 * 谁要是拿它去 repo.save，就会把继承自模板的词写死进管理处那一行 —— 模板从此改不动它。
 * 需要落库的地方（更正工单类型时学词）必须自己按 id 重新查实体，见 RepairsService。
 */
export type RepairTypeRuleView = RepairTypeRule & {
  /**
   * 公司模板那一份词，**原样**给出（本处停用掉的也在里面）——
   * 配置页要把它们连同「已停用」的状态一起显示，才能让人把停掉的词恢复回来。
   * 真正生效的那份是 contentSuggestions。
   */
  templateSuggestions: string[];
  /** 本处屏蔽掉的模板词，配置页要显示成「已停用」好让人恢复 */
  mutedSuggestions: string[];
};

/**
 * 生效关键词 = 本处增补 ∪ （公司模板 − 本处屏蔽）。
 *
 * 本处增补排在模板词前面：本地叫法（「抬杆机」）比通用词更贴当地人的嘴，
 * 猜你想输的第一屏就该是它们。
 */
export function mergeSuggestions(
  extra: string[] | null | undefined,
  template: string[] | null | undefined,
  muted: string[] | null | undefined,
): string[] {
  const blocked = new Set(muted ?? []);
  const out: string[] = [];
  for (const word of extra ?? []) {
    if (word && !out.includes(word)) out.push(word);
  }
  for (const word of template ?? []) {
    if (word && !blocked.has(word) && !out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * 把一条规则摊成视图：公司模板行自己就是模板，管理处行去模板里取同编码那条。
 * 管理处自建、模板里没有的类型，模板层就是空的，全靠本处增补。
 */
export function toRuleView(
  rule: RepairTypeRule,
  templateByType: Map<string, RepairTypeRule>,
): RepairTypeRuleView {
  if (rule.officeId === null) {
    return {
      ...rule,
      contentSuggestions: rule.contentSuggestions ?? [],
      extraSuggestions: [],
      mutedSuggestions: [],
      templateSuggestions: rule.contentSuggestions ?? [],
    };
  }
  const template = templateByType.get(rule.repairType);
  const muted = rule.mutedSuggestions ?? [];
  return {
    ...rule,
    contentSuggestions: mergeSuggestions(rule.extraSuggestions, template?.contentSuggestions, muted),
    extraSuggestions: rule.extraSuggestions ?? [],
    mutedSuggestions: muted,
    templateSuggestions: template?.contentSuggestions ?? [],
  };
}

export function toRuleViews(
  rules: RepairTypeRule[],
  templates: RepairTypeRule[],
): RepairTypeRuleView[] {
  const byType = new Map(templates.map((rule) => [rule.repairType, rule] as const));
  return rules.map((rule) => toRuleView(rule, byType));
}

/**
 * 给一个管理处建它自己那套报修类型规则：从公司默认模板（office_id 为空）复制。
 * 已经有了就原样返回，不重复建。
 *
 * 两个入口共用：后台「报修类型配置」第一次打开某管理处的 Tab（懒复制），
 * 以及「管理处」页新建管理处那一刻（2026-08-27 要求：新建管理处时同步建好，不用等人去点）。
 *
 * **关键词不复制**（2026-08-31）：复制过来就等于和模板断了联系，公司层之后补的词一个都收不到。
 * 类型名 / 默认维修工 / 时限照旧复制 —— 那些本来就该各管理处各不相同。
 */
export async function ensureOfficeRepairRules(
  repo: Repository<RepairTypeRule>,
  tenantId: number,
  officeId: number,
  operatorId: number | null,
): Promise<RepairTypeRule[]> {
  const own = await repo.find({
    where: { tenantId, officeId },
    order: { sortOrder: 'ASC', id: 'ASC' },
  });
  if (own.length) return own;
  const template = await repo.find({
    where: { tenantId, officeId: IsNull() },
    order: { sortOrder: 'ASC', id: 'ASC' },
  });
  if (!template.length) return [];
  const copied = await repo.save(
    template.map((rule) =>
      repo.create({
        tenantId,
        officeId,
        repairType: rule.repairType,
        label: rule.label,
        assigneeId: rule.assigneeId,
        assigneeIds: ruleAssigneeIds(rule),
        slaHours: rule.slaHours,
        sortOrder: rule.sortOrder,
        enabled: rule.enabled,
        contentSuggestions: [],
        extraSuggestions: [],
        mutedSuggestions: [],
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    ),
  );
  return copied.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
