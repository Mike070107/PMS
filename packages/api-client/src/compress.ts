/**
 * All miniapp media entries converge on uploadFile(). Native WeChat compression reduces upload bytes;
 * the shared API then attempts real WebP encoding for static images from both miniapps and Web.
 * Videos use compressVideo, never WebP. Keep the original on failure or if compression grows it.
 */
const IMAGE_THRESHOLD = 600 * 1024;
const VIDEO_THRESHOLD = 1024 * 1024;
// PNG/WebP can be animated. Native APIs expose no frame count; let the server inspect them safely.
const IMAGE_EXT = /\.(jpe?g|heic|heif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
const KEEP_EXT = /\.(png|webp|gif|pdf|xlsx?|docx?|pptx?|zip|csv|txt)$/i;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
type MediaKind = 'image' | 'video' | null;

function hasWx(): boolean {
  // @ts-ignore miniapp runtime
  return typeof wx !== 'undefined';
}
function fileSize(path: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      // @ts-ignore miniapp runtime
      wx.getFileSystemManager().getFileInfo({ filePath: path, success: (r: any) => resolve(Number(r?.size) || 0), fail: () => resolve(0) });
    } catch { resolve(0); }
  });
}
async function mediaKind(path: string): Promise<MediaKind> {
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  if (KEEP_EXT.test(path)) return null;
  // Camera/album temp files need not have an extension. Probe with native metadata, not renaming.
  const image = await new Promise<boolean>((resolve) => {
    try {
      // @ts-ignore miniapp runtime
      wx.getImageInfo({ src: path, success: (r: any) => resolve(!!r?.width && !!r?.height && /^(jpe?g|heic|heif|bmp)$/i.test(String(r?.type || ''))), fail: () => resolve(false) });
    } catch { resolve(false); }
  });
  if (image) return 'image';
  return new Promise<MediaKind>((resolve) => {
    try {
      // @ts-ignore miniapp runtime
      wx.getVideoInfo({ src: path, success: (r: any) => resolve(Number(r?.duration) > 0 ? 'video' : null), fail: () => resolve(null) });
    } catch { resolve(null); }
  });
}
async function compressKnown(path: string, kind: 'image' | 'video'): Promise<string> {
  const size = await fileSize(path);
  if (!size || size <= (kind === 'image' ? IMAGE_THRESHOLD : VIDEO_THRESHOLD)) return path;
  const candidate = await new Promise<string>((resolve) => {
    const handlers = { success: (r: any) => resolve(r?.tempFilePath || path), fail: () => resolve(path) };
    try {
      if (kind === 'image') {
        // @ts-ignore miniapp runtime
        wx.compressImage({ src: path, quality: 80, ...handlers });
      } else {
        // @ts-ignore miniapp runtime
        wx.compressVideo({ src: path, quality: 'medium', ...handlers });
      }
    } catch { resolve(path); }
  });
  if (!candidate || candidate === path) return path;
  const compressedSize = await fileSize(candidate);
  return compressedSize > 0 && compressedSize < size ? candidate : path;
}
/** Backward-compatible image-only helper. */
export async function compressImageIfNeeded(path: string): Promise<string> {
  if (!hasWx() || !path) return path;
  return await mediaKind(path) === 'image' ? compressKnown(path, 'image') : path;
}
export async function compressMediaIfNeeded(path: string): Promise<string> {
  if (!hasWx() || !path) return path;
  const kind = await mediaKind(path);
  const result = kind ? await compressKnown(path, kind) : path;
  if (await fileSize(result) > MAX_UPLOAD_BYTES) {
    throw new Error('文件压缩后仍超过50MB，请缩短视频或降低分辨率后重试');
  }
  return result;
}
