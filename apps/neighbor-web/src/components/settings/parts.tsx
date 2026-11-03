import type { ReactNode } from 'react';

/** 开关：大按钮，老同事也点得准 */
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: [string, string] }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`tg ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <i />{label ? <span>{on ? label[0] : label[1]}</span> : null}
    </button>
  );
}

/** 设置区块：标题 + 一句话说明 + 右侧操作 */
export function Section({ title, desc, extra, children }: { title: string; desc?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="set-sec">
      <div className="set-sec-hd">
        <div><h2>{title}</h2>{desc ? <p>{desc}</p> : null}</div>
        {extra ? <div className="set-sec-x">{extra}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** 结果提示：把服务商 / 微信的原话直接显示，不笼统成「失败」 */
export function ResultNote({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <div className={`set-result ${ok ? 'ok' : 'bad'}`}>{children}</div>;
}

/** 一行设置：左标签、右控件 + 说明 */
export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="set-row">
      <label>{label}</label>
      <div>{children}{hint ? <div className="hint">{hint}</div> : null}</div>
    </div>
  );
}

/** 小统计块 */
export function Stat({ label, value, hint, warn }: { label: string; value: ReactNode; hint?: ReactNode; warn?: boolean }) {
  return <div className={`set-stat ${warn ? 'warn' : ''}`}><small>{label}</small><b>{value}</b>{hint ? <em>{hint}</em> : null}</div>;
}

/** 居中表单弹窗（比抽屉更适合短表单） */
export function FormModal({ open, title, onClose, onOk, okText = '保存', busy, width = 560, children }: {
  open: boolean; title: string; onClose: () => void; onOk: () => void; okText?: string; busy?: boolean; width?: number; children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="cmdk set-modal" onClick={() => { if (!busy) onClose(); }}>
      <div className="box" style={{ width: `min(${width}px, 100%)` }} onClick={(e) => e.stopPropagation()}>
        <div className="set-modal-hd"><h3>{title}</h3><button className="btn g sm" onClick={onClose} disabled={busy}>✕</button></div>
        <div className="set-modal-bd">{children}</div>
        <div className="set-modal-ft">
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn p" onClick={onOk} disabled={busy}>{busy ? '保存中…' : okText}</button>
        </div>
      </div>
    </div>
  );
}

export const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
export const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
