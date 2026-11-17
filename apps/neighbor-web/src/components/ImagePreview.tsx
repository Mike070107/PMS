import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@/components/Icon';
import './image-preview.css';

export interface PreviewImage { fileUrl: string; fileName: string }

export default function ImagePreview({ files, initialIndex, title, onClose }: { files: PreviewImage[]; initialIndex: number; title: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; px: number; py: number } | null>(null);
  const file = files[index];
  const changeZoom = (delta: number) => setZoom((n) => Math.max(0.5, Math.min(5, n + delta)));
  useEffect(() => {
    const el = dialog.current;
    const wheel = (e: WheelEvent) => { e.preventDefault(); if (!failed && e.deltaY !== 0) changeZoom(e.deltaY < 0 ? 0.2 : -0.2); };
    el?.addEventListener('wheel', wheel, { passive: false });
    return () => el?.removeEventListener('wheel', wheel);
  }, [failed]);
  const move = (step: number) => setIndex((n) => (n + step + files.length) % files.length);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = dialog.current;
    const overflow = document.body.style.overflow;
    el?.showModal(); // Native modal makes the rest of the document inert and confines Tab focus.
    document.body.style.overflow = 'hidden';
    return () => { el?.close(); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setFailed(false); drag.current = null; }, [index]);
  return createPortal(
    <dialog ref={dialog} className="np-image-preview" aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
        if (e.key === 'Tab') {
          const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
          const first = controls[0]; const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
        if (['+', '=', '-', '0'].includes(e.key)) { e.preventDefault(); if (e.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }); } else changeZoom(e.key === '-' ? -0.2 : 0.2); }
        if (files.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); move(e.key === 'ArrowLeft' ? -1 : 1); }
      }}>
      <div className="np-preview-shell">
        <header className="np-preview-header"><div><b>{title}</b><span>{file.fileName}</span></div><button type="button" className="btn" onClick={onClose} autoFocus aria-label="关闭图片预览"><Icon name="x" size={20} /></button></header>
        <div className="np-preview-stage" ref={stage}
          onClick={(e) => {
            if (moved.current) return;
            const img = stage.current?.querySelector('img');
            if (!img || !img.naturalWidth) return;
            // object-fit: contain leaves letterboxed space inside the img element.
            // Close only on that empty space, never on the photo or after a drag.
            const r = img.getBoundingClientRect();
            const ratio = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
            const w = img.naturalWidth * ratio, h = img.naturalHeight * ratio;
            if (Math.abs(e.clientX - (r.left + r.width / 2)) > w / 2 || Math.abs(e.clientY - (r.top + r.height / 2)) > h / 2) onClose();
          }}
          onPointerDown={(e) => { moved.current = false; if (failed || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; }}
          onPointerMove={(e) => { const d = drag.current; if (d?.id === e.pointerId) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) moved.current = true; setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }); } }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
          {failed ? <div className="np-preview-error" role="alert"><Icon name="alert" size={28} /><b>图片加载失败</b><span>请关闭后重试，或切换其他资料。</span></div>
            : <div className="np-preview-zoom" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}><img key={file.fileUrl} src={file.fileUrl} alt={file.fileName} draggable={false} onError={() => setFailed(true)} /></div>}
        </div>
        {files.length > 1 ? <><button type="button" className="btn np-preview-prev" onClick={() => move(-1)} aria-label="上一张">‹</button><button type="button" className="btn np-preview-next" onClick={() => move(1)} aria-label="下一张">›</button></> : null}
        <footer className="np-preview-footer">
          <span aria-live="polite">{files.length > 1 ? `${index + 1} / ${files.length}` : '单张图片'}</span>
          <button type="button" className="btn" aria-label="缩小" disabled={failed || zoom <= 0.5} onClick={() => changeZoom(-0.2)}>−</button>
          <output aria-label="缩放比例">{Math.round(zoom * 100)}%</output>
          <button type="button" className="btn" aria-label="放大" disabled={failed || zoom >= 5} onClick={() => changeZoom(0.2)}>+</button>
          <button type="button" className="btn" disabled={failed} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>复位</button>
          <span className="np-preview-hint">滚轮缩放 · 按住拖动 · Esc 关闭{files.length > 1 ? ' · ← → 切换' : ''} · + / − 缩放，0 复位</span>
        </footer>
      </div>
    </dialog>, document.body,
  );
}
