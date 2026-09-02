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

export interface MyFeedbackHistoryItem {
  status: FeedbackStatus;
  note: string;
  at: string;
}

export interface MyFeedbackItem {
  id: number;
  type: FeedbackType;
  status: FeedbackStatus;
  message: string;
  handlingNote: string;
  attachments: Array<{ type: 'image' | 'video'; url: string }>;
  history: MyFeedbackHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export const feedback = (data: UserFeedbackReq) =>
  request<{ ok: true; id: number }>({ method: 'POST', url: '/observability/feedback', data });

export const myFeedback = () =>
  request<MyFeedbackItem[]>({ method: 'GET', url: '/observability/my-feedback' });
