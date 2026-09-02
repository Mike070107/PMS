import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

export type FeedbackAttachment = { type: 'image' | 'video'; url: string };

/** 反馈只能引用本系统刚上传的私有附件，且严格限制为 4 图 1 视频。 */
export function safeFeedbackAttachments(value: FeedbackAttachment[] | undefined, req: Request) {
  if (!value?.length) return [];
  const images = value.filter((item) => item.type === 'image');
  const videos = value.filter((item) => item.type === 'video');
  if (images.length > 4 || videos.length > 1) {
    throw new BadRequestException('反馈最多上传 4 张图片和 1 个视频');
  }
  return value.map((item) => {
    const url = String(item.url || '').trim();
    let parsed: URL;
    try { parsed = new URL(url, 'https://feedback.local'); }
    catch { throw new BadRequestException('反馈附件地址无效'); }
    const key = parsed.searchParams.get('key') || '';
    const relative = url.startsWith('/');
    if (
      (!relative && parsed.host !== req.get('host'))
      || !parsed.pathname.endsWith('/upload/file')
      || !key.startsWith('uploads/')
    ) {
      throw new BadRequestException('反馈附件必须先通过系统上传');
    }
    return { type: item.type, url: url.slice(0, 800) };
  });
}
