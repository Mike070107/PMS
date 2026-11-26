import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Image, Modal, Space, Spin, Typography } from 'antd';
import { isVideoUrl } from '@pms/shared-types';
import './work-order-media.css';

const { Text } = Typography;

export default function AttachmentPreview({ urls, size = 96 }: { urls: string[]; size?: number }) {
  const [video, setVideo] = useState<string | null>(null);
  let videoIndex = 0;
  if (!urls.length) return <Text type="secondary">未上传</Text>;
  return <>
    <Image.PreviewGroup>
      <Space size={[12, 12]} wrap style={{ maxWidth: '100%' }}>
        {urls.map((url, i) => isVideoUrl(url)
          ? <button type="button" key={`${url}-${i}`} className="workorder-video-thumb" style={{ width: size, height: size }} aria-label={`预览视频 ${++videoIndex}`} onClick={() => setVideo(url)}>
              <video src={url} preload="metadata" muted playsInline aria-hidden="true" tabIndex={-1}/>
              <span aria-hidden="true">▶</span>
            </button>
          : <AttachmentPhoto key={`${url}-${i}`} url={url} size={size} />)}
      </Space>
    </Image.PreviewGroup>
    <Modal title="视频预览" open={video !== null} onCancel={() => setVideo(null)} footer={null} destroyOnHidden width="calc(100vw - 16px)" style={{ top: 8, paddingBottom: 0 }}>
      {video ? <AttachmentVideo key={video} url={video} /> : null}
    </Modal>
  </>;
}

function AttachmentPhoto({ url, size }: { url: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <div style={{ maxWidth: '100%' }}>
    <Image key={attempt} src={url} width={size} height={size} alt="工单附件照片" style={{ objectFit: 'cover', borderRadius: 8 }} preview={{ src: url }} fallback="" onError={() => setFailed(true)} onLoad={() => setFailed(false)} />
    {failed ? <div role="alert"><Text type="secondary">照片加载失败</Text><Button onClick={() => { setFailed(false); setAttempt((n) => n + 1); }} style={{ minHeight: 44 }}>重试照片</Button></div> : null}
  </div>;
}

function AttachmentVideo({ url }: { url: string }) {
  const player = useRef<HTMLVideoElement>(null);
  const focusTarget = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    const media = player.current;
    return () => { media?.pause(); media?.removeAttribute('src'); media?.load(); };
  }, []);
  // Retrying removes the focused error button; keep Escape/Tab inside the modal.
  useEffect(() => { focusTarget.current?.focus({ preventScroll: true }); }, [failed]);
  return <div ref={focusTarget} tabIndex={-1}>
    {waiting && !failed ? <div role="status"><Spin size="small" /> 正在加载视频…</div> : null}
    <video ref={player} data-work-order-player src={url} controls autoPlay playsInline preload="metadata" hidden={failed}
      onLoadedData={() => setWaiting(false)} onCanPlay={() => setWaiting(false)} onPlaying={() => setWaiting(false)} onWaiting={() => setWaiting(true)} onError={() => { setFailed(true); setWaiting(false); }}
      style={{ display: failed ? 'none' : 'block', width: '100%', height: 'calc(100dvh - 125px)', objectFit: 'contain', background: '#000', borderRadius: 8 }} />
    {failed ? <Alert type="error" showIcon message="视频加载失败" description="请检查网络或视频格式后重试" action={<Button aria-label="重试" onClick={() => { setFailed(false); setWaiting(true); player.current?.load(); }} style={{ minHeight: 44 }}>重试</Button>} /> : null}
  </div>;
}
