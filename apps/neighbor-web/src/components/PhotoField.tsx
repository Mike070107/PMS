import { useEffect, useId, useRef, useState } from 'react';
import { isVideoUrl } from '@pms/shared-types';
import WorkOrderMedia from './WorkOrderMedia';
import Icon from '@/components/Icon';
import ImagePreview from '@/components/ImagePreview';
import ImagePreviewButton from '@/components/ImagePreviewButton';
import { toast } from '@/components/ui';
import { uploadImage } from '@/lib/upload';

export interface PhotoUploadStatus { uploading: boolean; failedCount: number }
interface Props {
  value: string[];
  onChange: (urls: string[]) => void;
  max?: number;
  size?: number;
  accept?: string;
  asTags?: boolean;
  disabled?: boolean;
  /** Allows a containing form to wait for uploads and explicitly resolve failed files. */
  onStatusChange?: (status: PhotoUploadStatus) => void;
}

/** One global paste receiver: most recently mounted or explicitly focused field wins. */
const stack: string[] = [];
const accepts = (file: File, accept: string) => file.type.startsWith('image/') || (accept.includes('video/') && file.type.startsWith('video/')) || (accept.includes('pdf') && file.type === 'application/pdf');
function filesFrom(dt: DataTransfer | null, accept: string): File[] {
  if (!dt) return [];
  const files = Array.from(dt.files || []).filter(file => accepts(file, accept));
  if (files.length) return files;
  return Array.from(dt.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile())
    .filter((file): file is File => !!file && accepts(file, accept));
}
const isTextTarget = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);
interface FailedUpload { file: File; message: string }

export default function PhotoField({ value, onChange, max = 6, size = 104, accept = 'image/*', asTags = false, disabled = false, onStatusChange }: Props) {
  const repairMedia = accept.includes('video/');
  const id = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<FailedUpload[]>([]);
  const [pasteTarget, setPasteTarget] = useState(false);
  const [over, setOver] = useState(false);
  const mounted = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onChange, max, busy, disabled, failed, onStatusChange });
  latest.current = { value, onChange, max, busy, disabled, failed, onStatusChange };
  const room = max - value.length;
  const activate = () => {
    const index = stack.indexOf(id);
    if (index >= 0) stack.splice(index, 1);
    stack.push(id);
    window.dispatchEvent(new Event('pms-photo-paste-target'));
  };
  useEffect(() => { onStatusChange?.({ uploading: busy, failedCount: failed.length }); }, [busy, failed.length, onStatusChange]);

  const add = async (files: File[], retry = false) => {
    const cur = latest.current;
    if (!files.length || cur.disabled || !mounted.current) return;
    if (cur.busy) { toast('上一批还在上传'); return; }
    const left = cur.max - cur.value.length;
    if (left <= 0) { toast(`最多 ${cur.max} 张，请先移除已有附件`); return; }
    if (!retry && files.length > left) toast(`最多 ${cur.max} 张，只添加前 ${left} 张`);
    const failures = retry ? cur.failed.slice(left) : [...cur.failed];
    // Set the ref synchronously too: two paste/drop events in one render cannot start parallel batches.
    cur.busy = true;
    cur.onStatusChange?.({ uploading: true, failedCount: failures.length });
    setBusy(true);
    const urls: string[] = [];
    try {
      for (const file of files.slice(0, left)) {
        if (!mounted.current) return;
        try {
          if (!accepts(file, accept)) throw new Error('请选择图片附件');
          if (repairMedia) {
            const existing = [...cur.value, ...urls];
            const videos = existing.filter(isVideoUrl).length;
            if (file.type.startsWith('video/') && videos >= 1) throw new Error('最多添加 1 段视频');
            if (file.type.startsWith('image/') && existing.length - videos >= 6) throw new Error('最多添加 6 张照片');
            if (file.size > 50 * 1024 * 1024) throw new Error('单个附件不能超过 50MB');
          } else if (file.size > 15 * 1024 * 1024) throw new Error('超过 15MB，请换一张较小的图片');
          urls.push(await uploadImage(file));
        } catch (error) {
          failures.push({ file, message: error instanceof Error ? error.message : '上传失败' });
        }
      }
    } finally {
      // Closing/resetting a form must never inject late URLs into another repair request.
      if (mounted.current) {
        latest.current.busy = false;
        setBusy(false);
        setFailed(failures);
        if (urls.length) latest.current.onChange([...latest.current.value, ...urls].slice(0, latest.current.max));
        latest.current.onStatusChange?.({ uploading: false, failedCount: failures.length });
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    const onTarget = () => setPasteTarget(stack[stack.length - 1] === id);
    window.addEventListener('pms-photo-paste-target', onTarget);
    activate();
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || stack[stack.length - 1] !== id || latest.current.disabled) return;
      const files = filesFrom(event.clipboardData, accept);
      if (!files.length || (isTextTarget(document.activeElement) && event.clipboardData?.getData('text/plain'))) return;
      event.preventDefault();
      void add(files);
    };
    window.addEventListener('paste', onPaste);
    return () => {
      mounted.current = false;
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('pms-photo-paste-target', onTarget);
      const index = stack.indexOf(id);
      if (index >= 0) stack.splice(index, 1);
      window.dispatchEvent(new Event('pms-photo-paste-target'));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, accept]);

  return (
    <div className="photo-field" onFocusCapture={activate} onPointerDownCapture={activate}>
      {value.map((url, index) => asTags ? (
        <span key={`${url}-${index}`} className="tag">
          {/\.pdf(?:[?#]|$)/i.test(url) ? <a href={url} target="_blank" rel="noreferrer">附件 {index + 1}（PDF）</a>
            : <ImagePreviewButton fileUrl={url} fileName={`附件 ${index + 1}`} files={value.map((fileUrl, i) => ({ fileUrl, fileName: `附件 ${i + 1}` })).filter(file => !/\.pdf(?:[?#]|$)/i.test(file.fileUrl))}>
              <img src={url} alt={`附件 ${index + 1}`} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4 }} />
            </ImagePreviewButton>}
          {disabled ? null : <button type="button" className="btn g sm" aria-label={`移除附件 ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>✕</button>}
        </span>
      ) : (
        <div key={`${url}-${index}`} className="photo-item" style={{ width: size, height: size }}>
          {repairMedia ? <WorkOrderMedia urls={[url]}/> : <button type="button" className="photo-preview-trigger" aria-label={`预览照片 ${index + 1}`} onClick={() => setPreview(index)}><img src={url} alt={`报修照片 ${index + 1}`} /></button>}
          {disabled ? null : <button type="button" className="btn sm" title="移除" aria-label={`移除附件 ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>✕</button>}
        </div>
      ))}
      {room > 0 && !disabled ? (
        <div tabIndex={0} role="button" aria-label={repairMedia ? '添加照片或视频' : '添加照片：点击、拖拽或 Ctrl+V 粘贴'} aria-busy={busy}
          data-paste-target={pasteTarget ? 'active' : undefined}
          className={`photo-drop ${repairMedia ? 'repair-media-drop' : ''} ${pasteTarget ? 'on' : ''} ${over ? 'over' : ''}`} style={asTags || repairMedia ? undefined : { width: size * 1.6, minHeight: size }}
          onClick={() => { if (!latest.current.busy) fileRef.current?.click(); }}
          onPaste={event => { if (isTextTarget(document.activeElement) && event.clipboardData.getData('text/plain')) return; const files = filesFrom(event.clipboardData, accept); if (files.length) { event.preventDefault(); void add(files); } }}
          onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={event => { event.preventDefault(); setOver(false); void add(filesFrom(event.dataTransfer, accept)); }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!latest.current.busy) fileRef.current?.click(); } }}>
          {busy ? <><div className="spin" /><span role="status">上传中…</span></> : repairMedia ? <><Icon name="image" size={22}/><strong>＋ 照片 / 视频</strong></> : <><Icon name="image" size={22} /><b>{pasteTarget ? '当前粘贴目标 · Ctrl+V' : '点击或 Ctrl+V 粘贴截图'}</b><span>也可拖入 · 每张不超过 15MB</span></>}
          <input ref={fileRef} type="file" aria-label={repairMedia ? '选择照片或视频' : '选择照片'} accept={accept} multiple hidden
            onClick={event => event.stopPropagation()}
            onChange={event => { void add(Array.from(event.target.files || [])); event.target.value = ''; }} />
        </div>
      ) : null}
      {preview !== null && value[preview] ? <ImagePreview files={value.map((fileUrl, i) => ({ fileUrl, fileName: `照片 ${i + 1}` }))} initialIndex={preview} title="照片预览" onClose={() => setPreview(null)} /> : null}
      {room <= 0 ? <span className="muted">已满 {max} 张</span> : null}
      {failed.length > 0 ? <div className="photo-upload-errors" role="alert" style={{ flexBasis: '100%', overflowWrap: 'anywhere' }}>
        {failed.map((item, index) => <div key={index}>{item.file.name}：{item.message}</div>)}
        <button type="button" className="btn g sm" disabled={disabled || busy} onClick={() => void add(failed.map(item => item.file), true)}>重试上传</button>
        <button type="button" className="btn g sm" disabled={disabled || busy} onClick={() => setFailed([])}>放弃失败照片</button>
      </div> : null}
    </div>
  );
}
