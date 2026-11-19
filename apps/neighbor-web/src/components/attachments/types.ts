export interface AttachmentRef { id: string; fileName: string; mimeType: string }
export interface PreviewAdapter {
  loadBlob(file: AttachmentRef, signal: AbortSignal): Promise<Blob>;
  renderPdf(file: AttachmentRef, signal: AbortSignal, firstOnly?: boolean): Promise<string[]>;
  download(file: AttachmentRef, signal: AbortSignal): Promise<void>;
}
export function previewError(error: unknown) {
  const e = error as {status?:number;response?:{status?:number};message?:string};
  const status = e?.status ?? e?.response?.status;
  if (status === 401 || status === 403) return '没有读取此附件的权限';
  if (status === 404) return '附件已不存在';
  return e?.message || '附件读取失败';
}
