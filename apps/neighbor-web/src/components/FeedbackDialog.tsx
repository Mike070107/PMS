import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { uploadImage } from '@/lib/upload';
import Icon from '@/components/Icon';
import { Sheet, toast } from '@/components/ui';
import '@/styles/feedback.css';

export type FeedbackType = 'suggestion' | 'error';
export interface ClientErrorEntry { at: string; message: string; page: string; ua: string }

const ERROR_BUFFER: ClientErrorEntry[] = [];
function pushClientError(message: string) {
  const text = String(message || '').trim();
  if (!text) return;
  ERROR_BUFFER.push({
    at: new Date().toISOString(),
    message: text.slice(0, 500),
    page: typeof window !== 'undefined' ? window.location.pathname : '',
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  });
  if (ERROR_BUFFER.length > 20) ERROR_BUFFER.splice(0, ERROR_BUFFER.length - 20);
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => pushClientError(event.message || '资源或脚本加载失败'));
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    pushClientError(reason instanceof Error ? reason.message : String(reason));
  });
}
export function recentClientErrors(limit = 3) {
  return ERROR_BUFFER.slice(-limit);
}

interface Attachment { id: string; file: File; preview?: string; url?: string; oversize?: boolean }
const MAX_FILES = 5;
const MAX_SIZE = 20 * 1024 * 1024;
let seq = 0;
const nextId = () => 'fb-' + Date.now() + '-' + (++seq);
const humanSize = (size: number) => size >= 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB';

export default function FeedbackDialog({ open, onClose, defaultType = 'suggestion' }: { open: boolean; onClose: () => void; defaultType?: FeedbackType }) {
  const [type, setType] = useState<FeedbackType>(defaultType);
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [includeErrors, setIncludeErrors] = useState(defaultType === 'error');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const images = attachments.filter((item) => item.preview);

  useEffect(() => {
    if (!open) return;
    setType(defaultType);
    setContent('');
    setAttachments([]);
    setIncludeErrors(defaultType === 'error');
    setBusy(false);
    setError('');
    setPreviewIndex(null);
  }, [open, defaultType]);
  useEffect(() => () => { attachments.forEach((item) => { if (item.preview) URL.revokeObjectURL(item.preview); }); }, [attachments]);
  // 高度自适应：文字多时变高，最高 240px 后内部滚动
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(240, Math.max(72, textarea.scrollHeight)) + 'px';
  }, [content, open]);
  // 灯箱键盘：Esc 关闭，左右切换
  useEffect(() => {
    if (previewIndex === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPreviewIndex(null); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setPreviewIndex((index) => index === null ? index : (index - 1 + images.length) % images.length); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setPreviewIndex((index) => index === null ? index : (index + 1) % images.length); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [previewIndex, images.length]);

  const hasOversize = attachments.some((item) => item.oversize);
  const canSend = !busy && !hasOversize && !!content.trim();
  const changeType = (next: FeedbackType) => {
    setType(next);
    setIncludeErrors(next === 'error');
  };
  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    const room = MAX_FILES - attachments.length;
    if (room <= 0) { setError('最多 5 个附件'); return; }
    setError('');
    const accepted: Attachment[] = [];
    for (const file of incoming.slice(0, room)) {
      const allowed = file.type.startsWith('image/') || file.type.startsWith('video/') || file.type === 'application/pdf';
      if (!allowed) { setError('仅支持图片、视频或 PDF 附件'); continue; }
      accepted.push({
        id: nextId(),
        file,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        oversize: file.size > MAX_SIZE,
      });
    }
    if (incoming.length > room) setError('最多 5 个附件');
    const oversize = accepted.find((item) => item.oversize);
    if (oversize) setError(`「${oversize.file.name}」超过 20MB，请移除后再发送`);
    setAttachments((prev) => [...prev, ...accepted]);
  };
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.flatMap((item) => {
      if (item.id !== id) return [item];
      if (item.preview) URL.revokeObjectURL(item.preview);
      return [];
    }));
    setPreviewIndex(null);
    setError((current) => current.startsWith('「') || current.startsWith('有附件') ? '' : current);
  };
  const onPaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault(); setDragOver(false);
    addFiles(event.dataTransfer.files);
  };
  const openPreview = (id: string) => {
    const index = images.findIndex((item) => item.id === id);
    if (index >= 0) setPreviewIndex(index);
  };

  const submit = async () => {
    const text = content.trim();
    if (hasOversize) { setError('有附件超过 20MB，请移除后再发送'); return; }
    if (!text) { setError('请填写意见或异常描述'); return; }
    if (text.length > 1000) { setError('内容不能超过 1000 字'); return; }
    setBusy(true); setError('');
    try {
      const urls: string[] = [];
      const next = attachments.map((item) => ({ ...item }));
      for (const item of next) {
        if (item.url) { urls.push(item.url); continue; }
        const url = await uploadImage(item.file);
        item.url = url;
        urls.push(url);
      }
      setAttachments(next);
      const payload: Record<string, unknown> = {
        kind: type,
        content: text,
        source: 'web',
        attachments: next.filter((item) => item.url).map((item) => ({ url: item.url, name: item.file.name, size: item.file.size, mime: item.file.type || undefined })),
        context: {
          page: typeof window !== 'undefined' ? window.location.pathname : '',
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          recentErrors: type === 'error' && includeErrors ? recentClientErrors(3).map((entry) => ({ at: entry.at, message: entry.message })) : [],
        },
      };
      await request({ method: 'POST', url: '/feedback', data: payload });
      toast('已提交，感谢你的反馈');
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '提交失败，请稍后重试；已填写的内容不会丢失');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Sheet open onClose={() => { if (!busy) onClose(); }} width={620} title="意见与建议 / 异常反馈" subtitle={type === 'error' ? '遇到问题或页面报错，描述一下发生了什么' : '对系统有什么想法，欢迎告诉我们'}>
      <div className="fb-form">
        <div className="chips" role="tablist" aria-label="反馈类型">
          <button type="button" role="tab" aria-selected={type === 'suggestion'} className={'chip ' + (type === 'suggestion' ? 'on' : '')} onClick={() => changeType('suggestion')}>意见与建议</button>
          <button type="button" role="tab" aria-selected={type === 'error'} className={'chip ' + (type === 'error' ? 'on' : '')} onClick={() => changeType('error')}>异常反馈</button>
        </div>

        <div
          className={'fb-composer' + (dragOver ? ' over' : '') + (hasOversize ? ' bad' : '')}
          onPaste={onPaste}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={(event) => { if (event.target === event.currentTarget) textareaRef.current?.focus(); }}
        >
          {attachments.length ? (
            <div className="fb-atts">
              {attachments.map((item) => (
                <div className={'fb-att' + (item.oversize ? ' bad' : '')} key={item.id}>
                  <div className="fb-thumb-wrap">
                    {item.preview ? (
                      <button type="button" className="fb-thumb" title="预览大图" onClick={(event) => { event.stopPropagation(); openPreview(item.id); }}>
                        <img src={item.preview} alt={item.file.name} />
                      </button>
                    ) : (
                      <div className="fb-thumb"><span className="fb-file-icon"><Icon name="file" size={20} /></span></div>
                    )}
                    <button type="button" className="fb-remove" aria-label={'移除附件 ' + item.file.name} disabled={busy} onClick={(event) => { event.stopPropagation(); removeAttachment(item.id); }}>×</button>
                  </div>
                  <div className="fb-att-meta"><b title={item.file.name}>{item.file.name}</b><small>{humanSize(item.file.size)}{item.oversize ? ' · 超过 20MB' : ''}</small></div>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="fb-input"
            maxLength={1000}
            value={content}
            disabled={busy}
            placeholder={type === 'error' ? '遇到什么问题？写清页面、操作步骤和报错信息' : '对系统有什么想法，欢迎告诉我们'}
            onChange={(event) => setContent(event.target.value)}
            aria-label="反馈内容"
          />
          <div className="fb-bar">
            <button type="button" className="fb-plus" title="添加附件" aria-label="添加附件" disabled={busy || attachments.length >= MAX_FILES} onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }}>+</button>
            <span className="fb-hint">Ctrl+V 粘贴 · 拖拽到框内</span>
            <button type="button" className="fb-send" title="发送" aria-label="发送" disabled={!canSend} onClick={() => void submit()}>
              {busy ? <span className="fb-sending" /> : <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>}
            </button>
          </div>
          <input ref={inputRef} type="file" multiple hidden accept="image/*,video/*,application/pdf" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
        </div>

        {error ? <div className="fb-error" role="alert">{error}</div> : null}
        <div className="fb-count">{content.length} / 1000</div>

        {type === 'error' ? (
          <label className="fb-check">
            <input type="checkbox" checked={includeErrors} disabled={busy} onChange={(event) => setIncludeErrors(event.target.checked)} />
            附上最近的系统报错（最近 3 条前端错误，含时间、页面、UA）
          </label>
        ) : null}

        {previewIndex !== null && images[previewIndex] ? (
          <div className="fb-lightbox" role="dialog" aria-modal="true" onClick={() => setPreviewIndex(null)}>
            <button type="button" className="fb-lb-close" aria-label="关闭预览" onClick={(event) => { event.stopPropagation(); setPreviewIndex(null); }}>×</button>
            {images.length > 1 ? <button type="button" className="fb-lb-arrow fb-lb-prev" aria-label="上一张" onClick={(event) => { event.stopPropagation(); setPreviewIndex((index) => index === null ? index : (index - 1 + images.length) % images.length); }}>‹</button> : null}
            <img className="fb-lb-img" src={images[previewIndex].preview} alt={images[previewIndex].file.name} onClick={(event) => event.stopPropagation()} />
            {images.length > 1 ? <button type="button" className="fb-lb-arrow fb-lb-next" aria-label="下一张" onClick={(event) => { event.stopPropagation(); setPreviewIndex((index) => index === null ? index : (index + 1) % images.length); }}>›</button> : null}
            <div className="fb-lb-count">{previewIndex + 1} / {images.length}</div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
