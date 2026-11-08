import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { apiBaseURL } from '@/lib/api';
import { auth } from '@/lib/auth';
import { uploadImage, uploadFileUrl } from '@/lib/upload';
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

interface Attachment { id: string; file: File; preview?: string; url?: string }
const MAX_FILES = 5;
const MAX_SIZE = 20 * 1024 * 1024;
let seq = 0;
const nextId = () => 'fb-' + Date.now() + '-' + (++seq);
const humanSize = (size: number) => size >= 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB';

function uploadHeaders() {
  const headers: Record<string, string> = { 'x-client-source': 'admin-web' };
  const token = auth.getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const tenant = auth.getActingTenant();
  if (tenant) headers['x-acting-tenant-id'] = String(tenant.id);
  const office = auth.getActingOffice();
  if (office) headers['x-acting-office-id'] = String(office.id);
  return headers;
}

async function uploadFeedbackFile(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const base = (apiBaseURL || '').replace(/\/$/, '');
  try {
    const res = await fetch(base + '/upload/file', { method: 'POST', body: form, headers: uploadHeaders() });
    const body = await res.json().catch(() => null) as any;
    const data = body?.data ?? body;
    const url = data?.url || data?.fileUrl || data?.displayUrl || data?.publicUrl;
    if (res.ok && url) return String(url);
    if (res.ok && data?.objectKey) return uploadFileUrl(String(data.objectKey));
    if (!file.type.startsWith('image/')) throw new Error(body?.message || '附件上传失败（HTTP ' + res.status + '）');
  } catch (e) {
    if (!file.type.startsWith('image/')) throw e;
  }
  // 老上传接口只接受图片；新上传接口未就绪时截图仍可先传
  return uploadImage(file);
}

export default function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<FeedbackType>('error');
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [includeErrors, setIncludeErrors] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setType('error'); setContent(''); setAttachments([]); setIncludeErrors(true); setBusy(false); setError('');
  }, [open]);
  useEffect(() => () => { attachments.forEach((item) => { if (item.preview) URL.revokeObjectURL(item.preview); }); }, [attachments]);

  const changeType = (next: FeedbackType) => {
    setType(next);
    setIncludeErrors(next === 'error');
  };
  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    const room = MAX_FILES - attachments.length;
    if (room <= 0) { toast('最多上传 5 个附件'); return; }
    const accepted: Attachment[] = [];
    for (const file of incoming.slice(0, room)) {
      if (file.size > MAX_SIZE) { toast(`「${file.name}」超过 20MB，已跳过`); continue; }
      accepted.push({ id: nextId(), file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined });
    }
    if (incoming.length > room) toast('最多上传 5 个附件');
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
  };
  const removeAttachment = (id: string) => setAttachments((prev) => prev.flatMap((item) => {
    if (item.id !== id) return [item];
    if (item.preview) URL.revokeObjectURL(item.preview);
    return [];
  }));
  const onPaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault(); setDragOver(false);
    addFiles(event.dataTransfer.files);
  };

  const submit = async () => {
    const text = content.trim();
    if (!text) { setError('请填写意见或异常描述'); return; }
    if (text.length > 1000) { setError('内容不能超过 1000 字'); return; }
    setBusy(true); setError('');
    try {
      const urls: string[] = [];
      const next = attachments.map((item) => ({ ...item }));
      for (const item of next) {
        if (item.url) { urls.push(item.url); continue; }
        const url = await uploadFeedbackFile(item.file);
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
          recentErrors: includeErrors ? recentClientErrors(3).map((entry) => ({ at: entry.at, message: entry.message })) : [],
        },
      };
      await request({ method: 'POST', url: '/feedback', data: payload });
      toast('已提交，感谢你的反馈');
      onClose();
    } catch (e) {
      setError(e instanceof Error && /[\u4e00-\u9fff]/.test(e.message) ? e.message : '提交失败，请稍后重试；已填写的内容不会丢失');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Sheet open onClose={() => { if (!busy) onClose(); }} width={620} title="意见与建议 / 异常反馈" subtitle={type === 'error' ? '遇到问题或页面报错，描述一下发生了什么' : '对系统有什么想法，欢迎告诉我们'}>
      <div className="fb-form" onPaste={onPaste} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <div className="chips" role="tablist" aria-label="反馈类型">
          <button type="button" role="tab" aria-selected={type === 'error'} className={'chip ' + (type === 'error' ? 'on' : '')} onClick={() => changeType('error')}>异常反馈</button>
          <button type="button" role="tab" aria-selected={type === 'suggestion'} className={'chip ' + (type === 'suggestion' ? 'on' : '')} onClick={() => changeType('suggestion')}>意见与建议</button>
        </div>

        <label className="fl">描述（必填，最多 1000 字）
          <textarea className="in fb-textarea" rows={6} maxLength={1000} value={content} disabled={busy} placeholder={type === 'error' ? '例如：点击保存后页面提示错误；请尽量写清页面、操作步骤和报错信息' : '例如：希望报表支持按小区对比'} onChange={(event) => setContent(event.target.value)} aria-label="反馈内容" />
        </label>
        <div className="fb-count">{content.length} / 1000</div>

        <div className="fb-field">
          <div className="fb-attach-head"><span>附件（可选，最多 5 个，单个 ≤20MB）</span><button type="button" className="btn sm" disabled={busy || attachments.length >= MAX_FILES} onClick={() => inputRef.current?.click()}><Icon name="link" size={14} />选择文件</button></div>
          <input ref={inputRef} type="file" multiple hidden accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ''; }} />
          <div className={'fb-drop' + (dragOver ? ' over' : '')} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}>
            点击选择、拖拽文件到这里，或直接 Ctrl+V 粘贴截图
          </div>
          {attachments.length ? (
            <div className="fb-attachments">
              {attachments.map((item) => (
                <div className="fb-attachment" key={item.id}>
                  {item.preview ? <img src={item.preview} alt={item.file.name} /> : <span className="fb-file-icon"><Icon name="file" size={18} /></span>}
                  <div className="fb-file-meta"><b title={item.file.name}>{item.file.name}</b><small>{humanSize(item.file.size)}{item.url ? ' · 已上传' : ''}</small></div>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => removeAttachment(item.id)}>删除</button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <label className="fb-check">
          <input type="checkbox" checked={includeErrors} disabled={busy} onChange={(event) => setIncludeErrors(event.target.checked)} />
          附上最近的系统报错（最近 3 条前端错误，含时间、页面、UA）
        </label>

        {error ? <div className="note2" role="alert" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{error}</div> : null}
        <div className="fb-actions">
          <button type="button" className="btn p" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交'}</button>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
        </div>
      </div>
    </Sheet>
  );
}
