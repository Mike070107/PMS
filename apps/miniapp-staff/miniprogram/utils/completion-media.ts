import { isVideoUrl, MAX_REPAIR_IMAGES, MAX_REPAIR_VIDEOS, MAX_REPAIR_VIDEO_SECONDS } from '@pms/shared-types';

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

/** 相册旧视频不受chooseMedia.maxDuration约束，必须读取真实本地文件。 */
export async function validateCompletionVideo(path: string): Promise<void> {
  let duration: number;
  try {
    duration = await new Promise<number>((resolve, reject) => wx.getVideoInfo({
      src: path,
      success: (result) => resolve(Number(result.duration)),
      fail: reject,
    }));
  } catch {
    throw new Error('无法读取视频时长，请重新选择不超过 15 秒的视频');
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法确认视频时长，请重新选择不超过 15 秒的视频');
  }
  // 与feedback一致，允许封装/帧精度的0.05秒误差，而不是放宽业务时长。
  if (duration > MAX_REPAIR_VIDEO_SECONDS + 0.05) {
    throw new Error(`视频最长 ${MAX_REPAIR_VIDEO_SECONDS} 秒，所选视频约 ${Math.ceil(duration)} 秒，请剪短后重选`);
  }
}
