/**
 * 员工工作范围（staff_assignments）的纯规则。
 *
 * 一行 = 「这个人在某个管理处（officeId=null 表示全部管理处）做哪些工种」。
 * 角色只决定「能做什么」（页面 / 动作），**在哪里做、做什么工种**只看这里：
 *  - 数据范围：有 null 行 = 全公司；否则 = 各行管理处的并集；
 *  - 派单匹配：某管理处的工单只看「null 行 + 该管理处那一行」的工种，
 *    所以「上海新家做电工泥工、永德段做电焊」不会互相串。
 */

export interface StaffAssignment {
  officeId: number | null;
  skills: string[];
}

/** 去重合并：同一管理处只留一行，工种取并集、保持首次出现顺序 */
export function normalizeAssignments(rows: ReadonlyArray<Partial<StaffAssignment>>): StaffAssignment[] {
  const byOffice = new Map<number | null, string[]>();
  for (const row of rows) {
    const raw = row.officeId;
    const officeId = raw === null || raw === undefined ? null : Number(raw);
    if (officeId !== null && (!Number.isInteger(officeId) || officeId <= 0)) continue;
    const skills = byOffice.get(officeId) ?? [];
    for (const s of row.skills ?? []) {
      const v = String(s ?? '').trim();
      if (v && !skills.includes(v)) skills.push(v);
    }
    byOffice.set(officeId, skills);
  }
  // 「全部管理处」排第一，其余按管理处 id
  return [...byOffice.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a - b))
    .map(([officeId, skills]) => ({ officeId, skills }));
}

export function scopeOfAssignments(rows: ReadonlyArray<StaffAssignment>): { all: boolean; officeIds: number[] } {
  const all = rows.some((r) => r.officeId === null);
  const officeIds = [...new Set(rows.map((r) => r.officeId).filter((v): v is number => v !== null))].sort((a, b) => a - b);
  return { all, officeIds };
}

/**
 * 是否覆盖某管理处：'all' = 有全部管理处那一行；'office' = 有这个管理处那一行。
 * officeId=null 表示「公司默认」，只有 'all' 才算覆盖。
 */
export function coverageOf(rows: ReadonlyArray<StaffAssignment>, officeId: number | null): 'all' | 'office' | null {
  if (rows.some((r) => r.officeId === null)) return 'all';
  if (officeId !== null && rows.some((r) => r.officeId === officeId)) return 'office';
  return null;
}

/**
 * 在某管理处能做的工种。officeId=undefined（不知道哪个管理处）→ 全部工种并集；
 * officeId=null（公司默认）→ 只算「全部管理处」那一行。
 */
export function skillsAtOffice(rows: ReadonlyArray<StaffAssignment>, officeId: number | null | undefined): string[] {
  if (officeId === undefined) return unionSkills(rows);
  const picked = rows.filter((r) => r.officeId === null || r.officeId === officeId);
  return unionSkills(picked);
}

export function unionSkills(rows: ReadonlyArray<StaffAssignment>): string[] {
  const out: string[] = [];
  for (const r of rows) for (const s of r.skills) if (!out.includes(s)) out.push(s);
  return out;
}

/** 操作者（受限范围）能不能分配这些范围：不能给「全部管理处」，也不能给自己范围外的管理处 */
export function assignmentsWithin(
  rows: ReadonlyArray<StaffAssignment>,
  operator: { all: boolean; officeIds: number[] },
): boolean {
  if (operator.all) return true;
  const mine = new Set(operator.officeIds);
  return rows.every((r) => r.officeId !== null && mine.has(r.officeId));
}

/**
 * 从旧的「角色数据范围」推出工作范围（一次性回填 + 旧后台建员工时的兼容）。
 * 有全公司范围的角色（含内置超管）→ 一行「全部管理处」；否则每个范围管理处一行。
 * 旧数据里工种是全局的，所以每行都带上同一组工种 —— 上线那一刻派单结果与原来完全一致，
 * 之后再到员工页逐人收窄（例如去掉某个管理处的电焊）。
 */
export function assignmentsFromRoles(
  roles: ReadonlyArray<{ builtIn: boolean; dataScope: string; officeIds: number[] }>,
  skills: ReadonlyArray<string>,
): StaffAssignment[] {
  if (!roles.length) return [];
  const all = roles.some((r) => r.builtIn || r.dataScope === 'all');
  const offices = all ? [null] : [...new Set(roles.flatMap((r) => r.officeIds))];
  return normalizeAssignments(offices.map((officeId) => ({ officeId, skills: [...skills] })));
}
