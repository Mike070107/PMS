import { request } from '../request';

export type FeedbackType = 'error' | 'hard_to_use' | 'data_issue' | 'suggestion' | 'other';
export type FeedbackStatus = 'new' | 'processing' | 'resolved' | 'ignored';

export interface UserFeedbackReq {
  source: 'admin-web' | 'miniapp-staff' | 'miniapp-owner';
  type: FeedbackType;
  message: string;
  route?: string;
  pageTitle?: string;
  version?: string;
  errorMessage?: string;
  context?: Record<string, unknown>;
  attachments?: Array<{ type: 'image' | 'video'; url: string }>;
}

export const feedback = (data: UserFeedbackReq) =>
  request<{ ok: true; id: number }>({ method: 'POST', url: '/observability/feedback', data });
