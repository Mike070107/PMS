import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isVideoUrl } from '@pms/shared-types';
import ImagePreview from '@/components/ImagePreview';
import './image-preview.css';
import '@/styles/work-order-media.css';

/** Display only: preserve stored/signed attachment URLs, never submit or rewrite them. */
export default function WorkOrderMedia({ urls }: { urls: string[] }) {
  const [image, setImage] = useState<number | null>(null);
  const [video, setVideo] = useState<string | null>(null);
  const images = urls.filter((url) => !isVideoUrl(url)).map((fileUrl, i) => ({ fileUrl, fileName: `照片 ${i + 1}` }));
  let imageIndex = -1;
  let videoIndex = -1;
  return <div className="wo-media-grid" onKeyDown={(e) => { if (e.key === 'Escape' && (image !== null || video !== null)) e.stopPropagation(); }}>
    {urls.map((url, i) => {
      if (isVideoUrl(url)) {
        const n = ++videoIndex;
        return <button type="button" className="wo-media-thumb wo-media-video" key={`${url}-${i}`} aria-label={`预览视频 ${n + 1}`} onClick={() => setVideo(url)}>
          <video className="wo-media-frame" src={url} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
          <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 4v16l13-8z" /></svg>
        </button>;
      }
      const n = ++imageIndex;
      return <button type="button" className="wo-media-thumb" key={`${url}-${i}`} aria-label={`预览照片 ${n + 1}`} onClick={() => setImage(n)}>
        <img src={url} alt={`照片 ${n + 1}`} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} onLoad={(e) => { e.currentTarget.style.visibility = ''; }} />
      </button>;
    })}
    {image !== null ? <ImagePreview viewport files={images} initialIndex={image} title="工单附件" onClose={() => setImage(null)} /> : null}
    {video ? <WorkOrderVideoPreview key={video} url={video} onClose={() => setVideo(null)} /> : null}
  </div>;
}

function WorkOrderVideoPreview({ url, onClose }: { url: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const close = () => { player.current?.pause(); onClose(); };
  useEffect(() => {
    const el = dialog.current;
    const media = player.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    el?.showModal();
    document.body.style.overflow = 'hidden';
    return () => { media?.pause(); media?.removeAttribute('src'); media?.load(); el?.close(); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className="np-image-preview wo-video-preview wo-viewport-preview" aria-label="视频预览" onCancel={(e) => { e.preventDefault(); close(); }}
    onClick={(e) => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } }}>
    <div className="np-preview-shell">
      <header className="np-preview-header"><div><b>视频预览</b><span>工单附件 · 本页播放</span></div><button type="button" className="btn" aria-label="关闭视频预览" onClick={close} autoFocus>关闭</button></header>
      <div className="wo-video-stage">
        {waiting && !failed ? <div role="status">正在加载视频…</div> : null}
        <video ref={player} data-work-order-player src={url} controls autoPlay playsInline preload="metadata" hidden={failed}
          onLoadedData={() => setWaiting(false)} onPlaying={() => setWaiting(false)} onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)} onError={() => { setFailed(true); setWaiting(false); }} />
        {failed ? <div className="wo-media-error" role="alert"><b>视频加载失败</b><span>请检查网络或视频格式后重试</span><button type="button" className="btn" onClick={() => { setFailed(false); setWaiting(true); player.current?.load(); }}>重试</button></div> : null}
      </div>
      <footer className="np-preview-footer">使用播放器控制播放、音量与全屏 · Esc 关闭</footer>
    </div>
  </dialog>, document.body);
}
