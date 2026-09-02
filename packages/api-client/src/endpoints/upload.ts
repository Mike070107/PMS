import { uploadFile, type UploadFileResp } from '../request';

export type { UploadFileResp };

/**
 * 上传一张本地图片/视频到后端（后端再转存对象存储），返回可写入 attachments 的地址。
 * 注意：后端未提供预签名直传接口，小程序统一走 POST /upload。
 */
export const uploadTempFile = (tempFilePath: string, timeout = 60000) => uploadFile(tempFilePath, timeout);

/** 批量上传，任何一张失败都会抛出（携带真实错误信息） */
export async function uploadTempFiles(tempFilePaths: string[]): Promise<UploadFileResp[]> {
  const results: UploadFileResp[] = [];
  for (const path of tempFilePaths) {
    results.push(await uploadFile(path));
  }
  return results;
}
