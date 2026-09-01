/**
 * 上传前的图片压缩（小程序端）。
 *
 * 为什么放在这里而不是每个页面各写一遍：全端 7 个选图入口最后都汇到
 * `uploadFile()` 这一条路上，压缩挂在这里，**任何新入口都自动享受，谁也漏不掉**。
 * 页面那边只负责在 `wx.chooseMedia` 里显式要压缩图（见各页 sizeType）——
 * 那是第一道，这里是第二道兜底：相册选「原图」、或某些机型默认没压，都会落到这里。
 *
 * 2026-09-01 调查过一次「为什么线上图片这么小」：我们代码里**一处压缩都没有**，
 * 7 个 chooseMedia 全没传 sizeType，也没调过 compressImage；
 * 图之所以只有 200~700KB，靠的是微信 chooseMedia 自己的默认行为。
 * 那是平台默认值，我们控制不了、也不该指望它 —— 所以补上这两道。
 *
 * 三条原则：
 * 1. **绝不因为压缩失败而上传不了**：任何一步出错都退回原图继续传。
 * 2. 只压图片，视频原样走（compressVideo 很慢，且报修视频已有 15 秒时长上限）。
 * 3. 小图不动：低于阈值的直接传，省一次编解码。
 */

/** 超过这个大小才压（字节）。低于它的图再压收益不大，还平白多一次编解码 */
const COMPRESS_THRESHOLD_BYTES = 600 * 1024;

/** wx.compressImage 的质量（0~100）。80 在手机屏上看不出差别，体积通常降到三分之一 */
const COMPRESS_QUALITY = 80;

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|bmp)$/i;

function hasWx(): boolean {
  // @ts-ignore — 小程序运行时注入
  return typeof wx !== 'undefined';
}

function fileSize(tempFilePath: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      // @ts-ignore — 小程序运行时注入
      wx.getFileSystemManager().getFileInfo({
        filePath: tempFilePath,
        success: (res: any) => resolve(Number(res?.size) || 0),
        fail: () => resolve(0),
      });
    } catch {
      resolve(0);
    }
  });
}

/**
 * 需要的话压一张图，返回可直接上传的路径。
 * 拿不准（不是图片 / 取不到大小 / 压缩失败）一律返回原路径。
 */
export function compressImageIfNeeded(tempFilePath: string): Promise<string> {
  if (!hasWx() || !tempFilePath) return Promise.resolve(tempFilePath);
  // 视频和其它文件不碰。注意临时路径可能不带扩展名，这时按「不是图片」处理，
  // 交给 chooseMedia 的 sizeType 那一道，别拿视频去调 compressImage
  if (!IMAGE_EXT.test(tempFilePath)) return Promise.resolve(tempFilePath);

  return fileSize(tempFilePath).then((size) => {
    if (!size || size <= COMPRESS_THRESHOLD_BYTES) return tempFilePath;
    return new Promise<string>((resolve) => {
      try {
        // @ts-ignore — 小程序运行时注入
        wx.compressImage({
          src: tempFilePath,
          quality: COMPRESS_QUALITY,
          success: (res: any) => resolve(res?.tempFilePath || tempFilePath),
          // 压不动就传原图：宁可多占点空间，也不能让人报不了修（原则 1）
          fail: () => resolve(tempFilePath),
        });
      } catch {
        resolve(tempFilePath);
      }
    });
  });
}
