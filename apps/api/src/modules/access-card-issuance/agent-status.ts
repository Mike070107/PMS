import type { AccessCardAgent } from '../../entities/access-card-agent.entity';

const AGENT_OFFLINE_AFTER_MS = 15_000;

/** 数据库中的 online 只代表最后一次心跳结果；页面状态必须同时检查心跳是否过期。 */
export function effectiveAgentStatus(
  agent: Pick<AccessCardAgent, 'status' | 'lastSeenAt'>,
  now = new Date(),
): AccessCardAgent['status'] {
  if (!agent.lastSeenAt || now.getTime() - agent.lastSeenAt.getTime() > AGENT_OFFLINE_AFTER_MS) {
    return 'offline';
  }
  return agent.status;
}

/**
 * 同一用途可能因重新注册保留多条记录。返回给页面时必须把仍在心跳的最新记录放在前面，
 * 不能让较早的离线记录遮住已经在线的替代网关。
 */
export function orderAgentsByAvailability<T extends Pick<AccessCardAgent, 'status' | 'lastSeenAt'>>(
  agents: T[],
  now = new Date(),
): T[] {
  return [...agents].sort((left, right) => {
    const leftOnline = effectiveAgentStatus(left, now) === 'online' ? 1 : 0;
    const rightOnline = effectiveAgentStatus(right, now) === 'online' ? 1 : 0;
    if (leftOnline !== rightOnline) return rightOnline - leftOnline;
    return (right.lastSeenAt?.getTime() ?? 0) - (left.lastSeenAt?.getTime() ?? 0);
  });
}
