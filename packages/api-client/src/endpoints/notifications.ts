import { request } from '../request';

export interface NotificationItem {
  id: number;
  eventKey: string;
  title: string;
  /** 里面带 page，点开直接跳到对应工单 */
  payload: Record<string, unknown> & { page?: string };
  readAt: string | null;
  createdAt: string;
}

export const list = (unread?: boolean) =>
  request<NotificationItem[]>({
    url: '/notifications',
    query: unread ? { unread: '1' } : undefined,
  });

export const unreadCount = () => request<{ count: number }>({ url: '/notifications/unread-count' });

export const markRead = (id: number) =>
  request<{ ok: true }>({ method: 'POST', url: `/notifications/${id}/read` });

export const markAllRead = () =>
  request<{ ok: true }>({ method: 'POST', url: '/notifications/read-all', data: {} });

/**
 * 上报订阅授权。只传用户点了「允许」的模板 id ——
 * 微信没有查余量的接口，服务端完全按这里记账，多报就会出现「以为能推其实推不出」。
 */
export const subscribe = (templateIds: string[]) =>
  request<{ ok: true; granted: number }>({
    method: 'POST',
    url: '/notifications/subscribe',
    data: { templateIds },
  });

/** 每个模板在服务端还剩几条额度（微信没有查余量的接口，只有这里记的账知道） */
export const subscribeState = (templateIds: string[]) =>
  request<Record<string, number>>({
    url: '/notifications/subscribe-state',
    query: { templateIds: templateIds.join(',') },
  });
