import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, message, Space, Spin, Tooltip } from 'antd';
import { DownloadOutlined, ReloadOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { type AttachmentRef, type PreviewAdapter, previewError } from './types';
import { usePreviewResource } from './usePreviewResource';
import { usePreviewViewport } from './usePreviewViewport';

export function PdfPreview({file,adapter,height='82vh'}:{file:AttachmentRef;adapter:PreviewAdapter;height?:string}) {
  const viewport=usePreviewViewport();
  const {id,fileName,mimeType}=file;
  const load=useCallback(async(signal:AbortSignal)=>{
    const pages=await adapter.renderPdf({id,fileName,mimeType},signal);
    if(!pages.length) throw new Error('该 PDF 没有可显示的页面');
    return pages;
  },[adapter,id,fileName,mimeType]);
  const pages=usePreviewResource(load);
  const download=useRef<AbortController>();
  const [downloading,setDownloading]=useState(false);
  const [ratios,setRatios]=useState<Record<string,number>>({});
  useEffect(()=>()=>download.current?.abort(),[]);
  async function handleDownload(){
    if(download.current) return;
    const c=new AbortController(); download.current=c; setDownloading(true);
    try { await adapter.download(file,c.signal); }
    catch(e){if(!c.signal.aborted) message.error(previewError(e));}
    finally {download.current=undefined;if(!c.signal.aborted)setDownloading(false);}
  }
  return <div style={{position:'relative'}}>
    <div style={{position:'absolute',top:8,right:12,zIndex:2}}>
      <Space.Compact>
        <Tooltip title="缩小"><Button aria-label="缩小" icon={<ZoomOutOutlined/>} onClick={()=>viewport.adjust(-.2)}/></Tooltip>
        <Button onClick={viewport.reset}>{Math.round(viewport.zoom*100)}%</Button>
        <Button aria-label="放大" icon={<ZoomInOutlined/>} onClick={()=>viewport.adjust(.2)}/>
        <Button aria-label="重置" icon={<ReloadOutlined/>} onClick={viewport.reset}/>
      </Space.Compact>
      <Button aria-label="下载原文件" icon={<DownloadOutlined/>} loading={downloading} onClick={handleDownload} style={{marginLeft:8}}/>
    </div>
    <div ref={viewport.scrollRef} {...viewport.drag} tabIndex={0} aria-label="PDF 页面" style={{height,overflow:'auto',background:'#525659',padding:'50px 16px 16px',boxSizing:'border-box',cursor:'grab',touchAction:'none',userSelect:'none'}}>
      {pages.error ? <Alert type="error" message={pages.error} action={<Button aria-label="重试" onClick={pages.retry}>重试</Button>}/> : !pages.value ? <Spin aria-label="正在加载 PDF"/> :
        pages.value.map((src,i)=><img key={i} src={src} alt={`第 ${i+1} 页`} draggable={false}
          onLoad={e=>{const ratio=e.currentTarget.naturalWidth/e.currentTarget.naturalHeight;setRatios(r=>r[i]===ratio?r:{...r,[i]:ratio});}}
          style={{display:'block',background:'#fff',margin:'0 auto 12px',width:Math.min(viewport.size.width-32,(viewport.size.height-66)*(ratios[i]||1))*viewport.zoom,maxWidth:'none',height:'auto',boxShadow:'0 1px 6px #0006'}}/>)}
    </div>
  </div>;
}
