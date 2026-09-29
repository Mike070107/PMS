import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveAgentStatus } from './agent-status';

const now = new Date('2026-09-29T08:00:00.000Z');

test('从未心跳或超过 15 秒的代理显示离线', () => {
  assert.equal(effectiveAgentStatus({ status: 'online', lastSeenAt: null }, now), 'offline');
  assert.equal(effectiveAgentStatus({
    status: 'online',
    lastSeenAt: new Date('2026-09-29T07:59:44.999Z'),
  }, now), 'offline');
});

test('新鲜心跳保留代理上报状态', () => {
  assert.equal(effectiveAgentStatus({
    status: 'online',
    lastSeenAt: new Date('2026-09-29T07:59:50.000Z'),
  }, now), 'online');
  assert.equal(effectiveAgentStatus({
    status: 'degraded',
    lastSeenAt: new Date('2026-09-29T07:59:50.000Z'),
  }, now), 'degraded');
});
