import { ApiError } from '@pms/api-client';

/**
 * 列表页的写操作（保存 / 删除 / 停用…）后端回 404 —— 这条数据已经不在库里了。
 *
 * 为什么单独处理：404 的文案是「角色不存在」「管理处不存在」这种，
 * 用户看了只会以为编辑功能坏了，反复点保存（2026-08-26 实际发生：
 * 后台把角色表清空重种，页面还挂着重种前的旧 id，编辑保存一直报「角色不存在」）。
 * 真实情况是列表过期了：别人刚删了它，或者服务端重建过数据。
 * 正确动作是说清楚「这条已经没了」，然后把列表刷新、关掉编辑框。
 *
 * 用法：写操作的 catch 里第一行 `if (handleGone(e, message, '这个角色', reload)) return;`
 * 只在「改/删已有记录」时调；新建（POST）的 404 是别的东西缺了，照常显示后端文案。
 * 新增列表页直接引这里，不要各写一套。
 */
export function handleGone(
  e: unknown,
  message: { warning: (content: string) => unknown },
  what: string,
  reload: () => void,
): boolean {
  if (!(e instanceof ApiError) || e.httpStatus !== 404) return false;
  message.warning(`${what}已经不存在了（可能刚被删除或重建），列表已刷新`);
  reload();
  return true;
}
