import { isVideoUrl, MAX_REPAIR_IMAGES, MAX_REPAIR_VIDEOS } from '@pms/shared-types';

/** 已上传URL仍保持string[]兼容旧工单；只为页面派生展示与配额。 */
export function completionMediaState(urls: string[]) {
  const completionMediaItems = urls.map((url, index) => ({ url, index, isVideo: isVideoUrl(url) }));
  const videos = completionMediaItems.filter((item) => item.isVideo).length;
  return {
    resultAttachments: urls.slice(),
    completionMediaItems,
    completionImageRemaining: Math.max(0, MAX_REPAIR_IMAGES - (urls.length - videos)),
    completionVideoRemaining: Math.max(0, MAX_REPAIR_VIDEOS - videos),
  };
}
