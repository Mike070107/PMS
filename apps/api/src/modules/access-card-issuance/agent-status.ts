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
