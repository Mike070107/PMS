import { useEffect, useId, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import { toast } from '@/components/ui';
import { uploadImage } from '@/lib/upload';

/**
 * 所有「加图片」的栏位共用：截图后 Ctrl+V 直接粘贴最方便，也支持拖入和从电脑选择。
 *
 * - 点一下虚线框即获得焦点，Ctrl+V 粘贴剪贴板里的图片（截图、网页上「复制图片」都行）；
 * - 表单打开时，即使没点框，只要光标不在文字输入框里，Ctrl+V 也会进到最后打开的那个图片栏；
 * - 文字输入框里粘贴的是图片（不是文字）时也接住，免得用户以为没反应。
 */
interface Props {
  value: string[];
  onChange: (urls: string[]) => void;
  max?: number;
  /** 缩略图边长 */
  size?: number;
  /** 默认只收图片；票据类可传 'image/*,application/pdf' */
  accept?: string;
  /** 附件不一定是图片（PDF）时用标签显示 */
  asTags?: boolean;
  disabled?: boolean;
}

/** 当前「接收全局粘贴」的栏位栈：最后挂载的优先 */
const stack: string[] = [];

function filesFrom(dt: DataTransfer | null, accept: string): File[] {
  if (!dt) return [];
  const ok = (f: File) => (accept.includes('pdf') && f.type === 'application/pdf') || f.type.startsWith('image/');
  const list = Array.from(dt.files || []).filter(ok);
  if (list.length) return list;
  return Array.from(dt.items || [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f && ok(f));
}

const isTextTarget = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

export default function PhotoField({ value, onChange, max = 6, size = 104, accept = 'image/*', asTags = false, disabled = false }: Props) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onChange, max, busy, disabled });
  latest.current = { value, onChange, max, busy, disabled };
  const room = max - value.length;

  const add = async (files: File[]) => {
    const cur = latest.current;
    if (!files.length || cur.disabled) return;
    if (cur.busy) { toast('上一张还在上传'); return; }
    const left = cur.max - cur.value.length;
    if (left <= 0) { toast(`最多 ${cur.max} 张`); return; }
    if (files.length > left) toast(`最多 ${cur.max} 张，只加了前 ${left} 张`);
    setBusy(true);
    const urls: string[] = [];
    try {
      for (const f of files.slice(0, left)) {
        if (f.size > 15 * 1024 * 1024) { toast(`「${f.name}」超过 15MB，跳过`); continue; }
        urls.push(await uploadImage(f));
      }
    } catch (e) { toast(e instanceof Error ? e.message : '上传失败'); }
    finally {
      setBusy(false);
      if (urls.length) { latest.current.onChange([...latest.current.value, ...urls].slice(0, latest.current.max)); toast(`已添加 ${urls.length} 张`); }
    }
  };

  // 全局粘贴：表单里任何位置（不在文字框里）Ctrl+V 都进这个栏；文字框里粘的是图片也接住
  useEffect(() => {
    stack.push(id);
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || stack[stack.length - 1] !== id) return;
      const files = filesFrom(e.clipboardData, accept);
      if (!files.length) return;
      const text = e.clipboardData?.getData('text/plain');
      if (isTextTarget(document.activeElement) && text) return; // 粘的是文字，交给输入框
      e.preventDefault();
      void add(files);
    };
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('paste', onPaste);
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, accept]);

  const zone = room > 0 && !disabled ? (
    <div
      tabIndex={0}
      role="button"
      className={`photo-drop ${focus ? 'on' : ''} ${over ? 'over' : ''}`}
      style={asTags ? undefined : { width: size * 1.6, height: size }}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onPaste={(e) => { const f = filesFrom(e.clipboardData, accept); if (f.length) { e.preventDefault(); void add(f); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void add(filesFrom(e.dataTransfer, accept)); }}
      onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click(); }}
    >
      {busy ? <><div className="spin" /><span>上传中…</span></> : (
        <>
          <Icon name="image" size={22} />
          <b>{focus ? '按 Ctrl+V 粘贴' : 'Ctrl+V 粘贴截图'}</b>
          <span>或拖进来 · <a onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>从电脑选</a></span>
        </>
      )}
      <input ref={fileRef} type="file" accept={accept} multiple hidden onChange={(e) => { void add(Array.from(e.target.files || [])); e.target.value = ''; }} />
    </div>
  ) : null;

  return (
    <div className="photo-field">
      {value.map((u, i) => asTags ? (
        <span key={u} className="tag">
          <a href={u} target="_blank" rel="noreferrer">附件 {i + 1}</a>
          {disabled ? null : <button className="btn g sm" style={{ height: 22, padding: '0 4px' }} onClick={() => onChange(value.filter((x) => x !== u))}>✕</button>}
        </span>
      ) : (
        <div key={u} className="photo-item" style={{ width: size, height: size }}>
          <a href={u} target="_blank" rel="noreferrer"><img src={u} alt="" /></a>
          {disabled ? null : <button className="btn sm" title="移除" onClick={() => onChange(value.filter((x) => x !== u))}>✕</button>}
        </div>
      ))}
      {zone}
      {room <= 0 && !asTags ? <span className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>已满 {max} 张</span> : null}
    </div>
  );
}
