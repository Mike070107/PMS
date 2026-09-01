/**
 * 后台上传前的图片压缩。全后台只有这一份实现，四个上传入口都引它。
 *
 * 为什么要有：小程序那边微信会替我们压一道（选图默认给压缩图，我们又显式要了
 * sizeType: ['compressed']），**后台是电脑选文件，一点都没压** —— 一张手机原图或
 * 单反照片几 MB 直接进对象存储，占空间、加载也慢。2026-09-01 量过线上桶：
 * 41 个文件 6.5MB，最大的几张 500~690KB 全是小程序来的；后台那条路只是还没人传大图，
 * 不是它安全。
 *
 * 做法：长边缩到 MAX_EDGE，再按 QUALITY 重新编码。
 *
 * **输出仍然是 JPEG，不是 WebP**：材料照片会在小程序 `<image>` 里显示，
 * 而 WebP 在不同 iOS/Android 微信版本上的表现需要真机验过才敢用。
 * 等验完再把 OUTPUT_TYPE 换成 'image/webp' 即可，其余不用动。
 *
 * 三条原则（和小程序端那份一致）：
 * 1. **绝不因为压缩失败而传不上去**：任何一步出错都退回原文件。
 * 2. 只处理位图照片：GIF（可能是动图）、SVG、PDF 一律原样放行。
 * 3. 已经够小、尺寸也不大的不动，省一次编解码。
 */

/** 长边上限（像素）。1600 够看清材料铭牌和报修现场，再大在屏幕上也看不出差别 */
const MAX_EDGE = 1600;

/** 重新编码的质量 */
const QUALITY = 0.82;

/** 小于这个大小且尺寸不超限的就别折腾了（字节） */
const SKIP_BELOW_BYTES = 300 * 1024;

const OUTPUT_TYPE = 'image/jpeg';

/** 动图和矢量图不能走 canvas：GIF 会只剩第一帧，SVG 会被栅格化 */
const SKIP_TYPES = /^image\/(gif|svg\+xml)$/i;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

/**
 * 需要的话压一张图，返回可直接上传的 File。
 * 拿不准（不是位图 / 解码失败 / 压完反而更大）一律返回原文件。
 */
export async function compressImageFile(file: File): Promise<File> {
  if (!/^image\//i.test(file.type) || SKIP_TYPES.test(file.type)) return file;
  try {
    const img = await loadImage(file);
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    if (file.size <= SKIP_BELOW_BYTES && longEdge <= MAX_EDGE) return file;

    const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // 相机直出的 JPEG 常带透明以外的背景假设；先铺白再画，避免 PNG 转 JPEG 后透明处变黑
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, OUTPUT_TYPE, QUALITY),
    );
    // 压完反而更大（本来就是高压缩的小图）就用原图，别帮倒忙
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: OUTPUT_TYPE, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/** 「2.4MB → 380KB」这种一句话，上传时提示用 */
export function describeSaving(before: number, after: number): string {
  const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
  return `${mb(before)} → ${mb(after)}`;
}
