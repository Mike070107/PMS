import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { statusOf } from '@/lib/format';

export function Pill({ status, extra }: { status: string; extra?: string }) {
  const s = statusOf(status);
  return <span className={`pill ${s.cls}`}>{s.name}{extra}</span>;
}

export function Btn({
  children, kind = '', size = '', onClick, disabled, title, type = 'button', style,
}: {
  children: ReactNode;
  kind?: '' | 'p' | 'd' | 'g';
  size?: '' | 'sm' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
}) {
  return (
    <button
      type={type}
      className={`btn ${kind} ${size}`.trim()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={style}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="muted" style={{ fontSize: 12.5 }}>{hint}</span> : null}
    </div>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <div className="card" style={style}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="empty">{text}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}>{children}</div>
  );
}

/* ---------------- Toast ---------------- */
type ToastItem = { id: number; text: string };
let toastPush: ((text: string) => void) | null = null;

export function toast(text: string) {
  toastPush?.(text);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    toastPush = (text: string) => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, text }]);
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 2400);
    };
    return () => { toastPush = null; };
  }, []);
  return (
    <>
      {items.map((i) => (
        <div className="toast" key={i.id}>{i.text}</div>
      ))}
    </>
  );
}

/* ---------------- 右侧抽屉 ---------------- */
export function Sheet({
  open, onClose, title, subtitle, width, children, headExtra,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  children: ReactNode;
  headExtra?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="sheet-mask" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label={typeof title === 'string' ? title : '详情'} style={width ? { width } : undefined}>
        <div className="sh-h">
          <div className="l1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{subtitle}</span>
            <button className="btn g sm x" style={{ marginLeft: 'auto' }} onClick={onClose}>✕ 关闭 <span className="kbd">Esc</span></button>
          </div>
          <h2>{title}</h2>
          {headExtra}
        </div>
        <div className="sh-b">{children}</div>
      </aside>
    </>
  );
}

/** 居中确认框：终止类操作必须让人看见后果 */
export function ConfirmModal({
  open, onClose, title, children, confirmText = '确认', danger, onConfirm, busy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  busy?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="cmdk" style={{ alignItems: 'center', paddingTop: 0 }} onClick={onClose}>
      <div className="box" style={{ width: 460, padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 10px', fontSize: 17 }}>{title}</h3>
        <div className="sub" style={{ fontSize: 13.5, lineHeight: 1.7, marginBottom: 16 }}>{children}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn onClick={onClose}>取消</Btn>
          <Btn kind={danger ? 'd' : 'p'} onClick={onConfirm} disabled={busy}>{busy ? '处理中…' : confirmText}</Btn>
        </div>
      </div>
    </div>
  );
}
