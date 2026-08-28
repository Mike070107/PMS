import { IsNull, Repository } from 'typeorm';
import { RepairTypeRule } from '../../entities';

/** 规则里的默认维修工：新字段优先，老数据只有 assignee_id 时兜底成单人数组 */
export function ruleAssigneeIds(rule: Pick<RepairTypeRule, 'assigneeId' | 'assigneeIds'>): number[] {
  if (rule.assigneeIds?.length) return rule.assigneeIds;
  return rule.assigneeId ? [rule.assigneeId] : [];
}

/**
 * 给一个管理处建它自己那套报修类型规则：从公司默认模板（office_id 为空）整套复制。
 * 已经有了就原样返回，不重复建。
 *
 * 两个入口共用：后台「报修类型配置」第一次打开某管理处的 Tab（懒复制），
 * 以及「管理处」页新建管理处那一刻（2026-08-27 要求：新建管理处时同步建好，不用等人去点）。
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
        contentSuggestions: [...(rule.contentSuggestions ?? [])],
        createdBy: operatorId,
        updatedBy: operatorId,
      }),
    ),
  );
  return copied.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
