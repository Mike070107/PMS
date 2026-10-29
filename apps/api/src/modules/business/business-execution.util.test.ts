import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { addMonthsClamped, aggregateSteps, classifyFailure, nextRetryAt, parseSyncMode, planDeliyunRenewal, planLocalRenewal, renewalWindow, splitAmountCents } from './business-execution.util';

const car = (over: Partial<{ id: string; plate: string; endDate: string | null; cardPoolId: string | null }> = {}) =>
  ({ id: 'v1', plate: '沪A12345', endDate: '2026-10-31', cardPoolId: null, ...over });

test('模式：默认演练，只有明确 on 才真写', () => {
  assert.equal(parseSyncMode(undefined), 'dry-run');
  assert.equal(parseSyncMode(''), 'dry-run');
  assert.equal(parseSyncMode('ON'), 'on');
  assert.equal(parseSyncMode('true'), 'on');
  assert.equal(parseSyncMode('off'), 'off');
  assert.equal(parseSyncMode('乱写'), 'dry-run');
});

test('正常续期：当前到期早于目标 → 续到目标，带上当前到期日做并发校验', () => {
  assert.deepEqual(planDeliyunRenewal({ plate: '沪A12345', targetEndDate: '2026-11-30', rows: [car()] }),
    { action: 'renew', vehicleId: 'v1', previousEndDate: '2026-10-31', endDate: '2026-11-30' });
});

test('幂等：德立云已是目标到期日 → 不再写', () => {
  const p = planDeliyunRenewal({ plate: '沪A12345', targetEndDate: '2026-10-31', rows: [car()] });
  assert.equal(p.action, 'noop');
});

test('不回退：德立云到期日更晚 → 转人工', () => {
  const p = planDeliyunRenewal({ plate: '沪A12345', targetEndDate: '2026-09-30', rows: [car()] });
  assert.equal(p.action, 'manual');
  assert.match((p as { reason: string }).reason, /不自动回退/);
});

test('对不上就转人工：未登记 / 多条 / 车位池 / 无到期日 / 无目标', () => {
  for (const [rows, target, re] of [
    [[], '2026-11-30', /未登记/],
    [[car(), car({ id: 'v2' })], '2026-11-30', /2 条/],
    [[car({ cardPoolId: 'p1' })], '2026-11-30', /车位池/],
    [[car({ endDate: null })], '2026-11-30', /没有到期日/],
    [[car()], null, /没有到期日/],
  ] as const) {
    const p = planDeliyunRenewal({ plate: '沪A12345', targetEndDate: target, rows: [...rows] });
    assert.equal(p.action, 'manual');
    assert.match((p as { reason: string }).reason, re);
  }
});

test('失败分类：数据类错误转人工，服务类错误重试，3 次后 failed', () => {
  assert.equal(classifyFailure(new BadRequestException('德立云车辆已变化'), 1).status, 'manual');
  assert.equal(classifyFailure(new ServiceUnavailableException('德立云有效期写入尚未启用'), 1).status, 'manual');
  assert.equal(classifyFailure(new ServiceUnavailableException('暂时不可用'), 1).status, 'retry');
  assert.equal(classifyFailure(new Error('ETIMEDOUT'), 2).status, 'retry');
  assert.equal(classifyFailure(new Error('ETIMEDOUT'), 3).status, 'failed');
});

test('重试间隔：1 / 5 / 15 分钟', () => {
  const t0 = new Date('2026-10-28T00:00:00Z');
  assert.equal((nextRetryAt(1, t0).getTime() - t0.getTime()) / 60000, 1);
  assert.equal((nextRetryAt(2, t0).getTime() - t0.getTime()) / 60000, 5);
  assert.equal((nextRetryAt(3, t0).getTime() - t0.getTime()) / 60000, 15);
  assert.equal((nextRetryAt(9, t0).getTime() - t0.getTime()) / 60000, 15);
});

test('续期区间：未到期接着原到期日续，已过期从今天起，结束日 = 开始 + N 月 − 1 天', () => {
  assert.deepEqual(renewalWindow({ currentEndDate: '2026-12-31', today: '2026-10-29', months: 6 }), { startDate: '2027-01-01', endDate: '2027-06-30' });
  assert.deepEqual(renewalWindow({ currentEndDate: '2026-10-29', today: '2026-10-29', months: 1 }), { startDate: '2026-10-30', endDate: '2026-11-29' });
  assert.deepEqual(renewalWindow({ currentEndDate: '2024-12-31', today: '2026-10-29', months: 12 }), { startDate: '2026-10-29', endDate: '2027-10-28' });
  assert.deepEqual(renewalWindow({ currentEndDate: null, today: '2026-11-01', months: 3 }), { startDate: '2026-11-01', endDate: '2027-01-31' });
  assert.equal(addMonthsClamped('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonthsClamped('2028-01-31', 1), '2028-02-29');
});

test('金额拆分：按分均分，余数给第一条，总额不变', () => {
  assert.deepEqual(splitAmountCents(100000, 3), [33334, 33333, 33333]);
  assert.equal(splitAmountCents(99999, 2).reduce((a, b) => a + b, 0), 99999);
  assert.deepEqual(splitAmountCents(500, 1), [500]);
});

test('多系统汇总：有在等的算排队，失败优先于人工，全部完成才算已同步', () => {
  const st = (status: 'pending' | 'waiting' | 'done' | 'manual' | 'failed' | 'dry_run') => ({ key: status, label: '', kind: 'local' as const, status });
  assert.equal(aggregateSteps([st('done'), st('waiting')]), 'queued');
  assert.equal(aggregateSteps([st('done'), st('failed'), st('manual')]), 'failed');
  assert.equal(aggregateSteps([st('done'), st('manual')]), 'manual');
  assert.equal(aggregateSteps([st('dry_run'), st('dry_run')]), 'dry_run');
  assert.equal(aggregateSteps([st('done'), st('done')]), 'synced');
});

test('旧库续期核对：只往后延', () => {
  assert.equal(planLocalRenewal({ previousEndDate: '2026-12-31 23:59:59', targetEndDate: '2027-06-30' }).action, 'renew');
  assert.equal(planLocalRenewal({ previousEndDate: '2027-06-30 23:59:59', targetEndDate: '2027-06-30' }).action, 'noop');
  assert.equal(planLocalRenewal({ previousEndDate: '2028-01-01', targetEndDate: '2027-06-30' }).action, 'manual');
  assert.equal(planLocalRenewal({ previousEndDate: null, targetEndDate: '2027-06-30' }).action, 'renew');
});
