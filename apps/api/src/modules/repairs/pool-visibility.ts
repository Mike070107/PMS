/**
 * 维修工的工单池里，「待接单」那部分该看到哪些单（2026-09-08 Mike 定）。
 *
 * 背景：原来工单池 = 本人数据范围内**所有**待接单。总公司维修工的数据范围是全公司，
 * 于是他能看到、也能抢走每个管理处的水 / 电 / 木工单；而按 Mike 的分工，
 * 那几类默认只该由本管理处的维修工修，总公司的人只修智能化 / 防水，
 * 其余疑难杂症等办公室指派。
 *
 * 收敛后维修工只看到三种（判定在服务里拼成 SQL 的 OR，见 poolClaimableWheres）：
 *   1. 建单时按类型规则推给我的（candidate_ids 含我，微信通知发的也是这批人）；
 *   2. **在这单所属管理处**、我被列为该类型默认维修工的（同类别互相顶班，不用等派单）；
 *   3. 一个候选都没有的单（类型没配默认维修工 / 判不出类型）—— 公开池，谁都能接。
 *
 * 这个文件只算第 2 条：我在哪些小区、能看哪些报修类型。
 * 必须**按管理处**算，不能只看「我被列进过哪些类型」——否则总公司维修工在吴泾被列为
 * 电相关默认维修工，枫桦的电相关单又会重新对他可见，等于没改。
 */

export interface PoolRuleLike {
  repairType: string;
  /** null = 公司默认模板 */
  officeId: number | null;
  enabled: boolean;
  assigneeId: number | null;
  assigneeIds: number[];
}

export interface PoolCommunityLike {
  id: number;
  officeId: number | null;
  parentId: number | null;
}

export interface PoolTypeScope {
  communityIds: number[];
  types: string[];
}

/** 规则里的默认维修工：新字段优先，老字段兜底（和 repair-rule-template.ts 同一口径） */
function assigneeIdsOf(rule: PoolRuleLike): number[] {
  if (rule.assigneeIds?.length) return rule.assigneeIds;
  return rule.assigneeId ? [rule.assigneeId] : [];
}

/**
 * 我在哪些小区能看到哪些类型的待接单。
 *
 * @param allowedCommunityIds 本人数据范围内的小区；null = 全公司范围
 * @returns 按「类型组合」聚合后的若干段，每段一条 SQL OR 条件
 */
export function poolTypeScopes(
  userId: number,
  rules: PoolRuleLike[],
  communities: PoolCommunityLike[],
  allowedCommunityIds: number[] | null,
): PoolTypeScope[] {
  if (!rules.length || !communities.length) return [];

  // 「这个管理处有没有自己的一套规则」——有就完全不看公司模板，和 rulesForCommunity 同一口径。
  // 注意用**全部**规则行判断（含停用的）：管理处一旦打开过配置页就复制了一整套，
  // 里面某条被停用不代表它回退到模板。
  const officesWithOwnRules = new Set<number>();
  const typesByOffice = new Map<number, string[]>();
  const templateTypes: string[] = [];
  for (const rule of rules) {
    if (rule.officeId) officesWithOwnRules.add(rule.officeId);
    if (!rule.enabled || !assigneeIdsOf(rule).includes(userId)) continue;
    if (rule.officeId) {
      const list = typesByOffice.get(rule.officeId) ?? [];
      if (!list.includes(rule.repairType)) list.push(rule.repairType);
      typesByOffice.set(rule.officeId, list);
    } else if (!templateTypes.includes(rule.repairType)) {
      templateTypes.push(rule.repairType);
    }
  }
  if (!typesByOffice.size && !templateTypes.length) return [];

  // 小区归属管理处：自己没挂就跟父级（分期子小区）
  const byId = new Map(communities.map((item) => [item.id, item]));
  const allowed = allowedCommunityIds ? new Set(allowedCommunityIds) : null;
  /** 类型组合相同的小区并成一段，别一个小区一条 OR */
  const grouped = new Map<string, { communityIds: number[]; types: string[] }>();
  for (const community of communities) {
    if (allowed && !allowed.has(community.id)) continue;
    const officeId =
      community.officeId ?? (community.parentId ? byId.get(community.parentId)?.officeId ?? null : null);
    const types =
      officeId && officesWithOwnRules.has(officeId)
        ? typesByOffice.get(officeId) ?? []
        : templateTypes;
    if (!types.length) continue;
    const key = [...types].sort().join('|');
    const hit = grouped.get(key);
    if (hit) hit.communityIds.push(community.id);
    else grouped.set(key, { communityIds: [community.id], types: [...types] });
  }
  return [...grouped.values()];
}
