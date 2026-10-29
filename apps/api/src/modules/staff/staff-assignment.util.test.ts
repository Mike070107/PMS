import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignmentsFromRoles,
  assignmentsWithin,
  coverageOf,
  normalizeAssignments,
  scopeOfAssignments,
  skillsAtOffice,
} from './staff-assignment.util';

// 张师傅：上海新家(5) 电工+泥工；永德段(3) 电焊
const zhang = normalizeAssignments([
  { officeId: 5, skills: ['electric', 'mason'] },
  { officeId: 3, skills: ['welding'] },
]);
// 李师傅：智能化，全部管理处
const li = normalizeAssignments([{ officeId: null, skills: ['smart'] }]);

test('同一管理处合并、去重、全部管理处排第一、非法 id 丢弃', () => {
  const rows = normalizeAssignments([
    { officeId: 5, skills: ['electric'] },
    { officeId: 5, skills: ['electric', ' mason '] },
    { officeId: null, skills: ['smart'] },
    { officeId: 0 as unknown as number, skills: ['x'] },
  ]);
  assert.deepEqual(rows, [
    { officeId: null, skills: ['smart'] },
    { officeId: 5, skills: ['electric', 'mason'] },
  ]);
});

test('工种按管理处匹配，不串到别的管理处', () => {
  assert.deepEqual(skillsAtOffice(zhang, 5), ['electric', 'mason']);
  assert.deepEqual(skillsAtOffice(zhang, 3), ['welding']);
  assert.deepEqual(skillsAtOffice(zhang, 1), []);
  assert.deepEqual(skillsAtOffice(zhang, undefined), ['welding', 'electric', 'mason']);
  assert.deepEqual(skillsAtOffice(li, 7), ['smart']);
  assert.deepEqual(skillsAtOffice(zhang, null), [], '公司默认只看全部管理处那一行');
});

test('数据范围与覆盖', () => {
  assert.deepEqual(scopeOfAssignments(zhang), { all: false, officeIds: [3, 5] });
  assert.deepEqual(scopeOfAssignments(li), { all: true, officeIds: [] });
  assert.equal(coverageOf(zhang, 5), 'office');
  assert.equal(coverageOf(zhang, 1), null);
  assert.equal(coverageOf(zhang, null), null);
  assert.equal(coverageOf(li, 9), 'all');
});

test('受限操作者只能分配自己范围内的管理处，不能给全部管理处', () => {
  const op = { all: false, officeIds: [3, 5] };
  assert.equal(assignmentsWithin(zhang, op), true);
  assert.equal(assignmentsWithin(li, op), false);
  assert.equal(assignmentsWithin(normalizeAssignments([{ officeId: 1, skills: [] }]), op), false);
  assert.equal(assignmentsWithin(li, { all: true, officeIds: [] }), true);
});

test('从旧角色范围回填：全公司角色 → 一行全部管理处；管理处角色 → 每处一行同一组工种', () => {
  assert.deepEqual(
    assignmentsFromRoles([{ builtIn: false, dataScope: 'offices', officeIds: [1] }, { builtIn: false, dataScope: 'offices', officeIds: [3, 1] }], ['water']),
    [{ officeId: 1, skills: ['water'] }, { officeId: 3, skills: ['water'] }],
  );
  assert.deepEqual(
    assignmentsFromRoles([{ builtIn: true, dataScope: 'all', officeIds: [] }, { builtIn: false, dataScope: 'offices', officeIds: [1] }], ['smart']),
    [{ officeId: null, skills: ['smart'] }],
  );
  assert.deepEqual(assignmentsFromRoles([], ['x']), []);
});
