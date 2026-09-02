import { request } from '../request';

export interface SubmitFeedbackPayload {
  content: string;
  imageUrls: string[];
  videoUrl?: string;
  videoDurationSeconds?: number;
}

export const submit = (data: SubmitFeedbackPayload) =>
  request<{ id: number; createdAt: string }>({
    method: 'POST',
    url: '/feedback',
    data,
  });
