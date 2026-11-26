import { isVideoUrl, MAX_REPAIR_IMAGES, MAX_REPAIR_VIDEOS, MAX_REPAIR_VIDEO_SECONDS } from '@pms/shared-types';

interface SelectedFile { tempFilePath: string; fileType?: string; thumbTempFilePath?: string }
declare const wx: {
  chooseMedia(options: object): Promise<{tempFiles: SelectedFile[]}>;
  getVideoInfo(options: {src: string; success: (result: {duration: number}) => void; fail: () => void}): void;
};

export async function chooseRepairMedia(urls: string[]) {
  const videos = urls.filter(isVideoUrl).length;
  const videoSlots = Math.max(0, MAX_REPAIR_VIDEOS - videos);
  const imageSlots = Math.max(0, MAX_REPAIR_IMAGES - urls.length + videos);
  if (!imageSlots && !videoSlots) return [];
  let selected;
  try {
    selected = await wx.chooseMedia({
      count: Math.min(9, imageSlots + videoSlots),
      mediaType: [...(imageSlots ? ['image'] : []), ...(videoSlots ? ['video'] : [])],
      sourceType: ['album', 'camera'], sizeType: ['original'], maxDuration: MAX_REPAIR_VIDEO_SECONDS,
    });
  } catch (err) {
    if (/cancel/i.test(String((err as {errMsg?: string}).errMsg || err))) return [];
    throw err;
  }
  const files = selected.tempFiles.map(file => ({
    ...file, isVideo: file.fileType === 'video' || (!file.fileType && isVideoUrl(file.tempFilePath)),
  }));
  const clips = files.filter(file => file.isVideo);
  if (files.length - clips.length > imageSlots) throw new Error(`照片最多 6 张，还可添加 ${imageSlots} 张，请重新选择`);
  if (clips.length > videoSlots) throw new Error(`视频最多 1 段，还可添加 ${videoSlots} 段，请重新选择`);
  for (const file of clips) {
    const duration = await new Promise<number>((resolve, reject) => wx.getVideoInfo({
      src: file.tempFilePath, success: info => resolve(Number(info.duration)),
      fail: () => reject(new Error('无法读取视频时长，请重新选择不超过 15 秒的视频')),
    }));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确认视频时长，请重新选择不超过 15 秒的视频');
    if (duration > MAX_REPAIR_VIDEO_SECONDS + 0.05) throw new Error('视频最长 15 秒，请剪短后重选');
  }
  return files;
}
