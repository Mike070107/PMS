import { useState, type CSSProperties, type ReactNode } from 'react';
import ImagePreview, { type PreviewImage } from './ImagePreview';

/** An inline image opener. All viewing behavior stays in the shared modal. */
export default function ImagePreviewButton({ fileUrl, fileName, children, files, className, style }: {
  fileUrl: string; fileName: string; children: ReactNode; files?: PreviewImage[];
  className?: string; style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const gallery = files?.length ? files : [{ fileUrl, fileName }];
  return <>
    <button type="button" className={className} aria-label={`预览图片：${fileName}`}
      style={{ border: 0, padding: 0, background: 'transparent', cursor: 'zoom-in', minWidth: 44, minHeight: 44, maxWidth: '100%', ...style }}
      onClick={event => { event.stopPropagation(); setOpen(true); }}>{children}</button>
    {open ? <ImagePreview files={gallery} initialIndex={Math.max(0, gallery.findIndex(file => file.fileUrl === fileUrl))}
      title="图片预览" onClose={() => setOpen(false)} /> : null}
  </>;
}
