import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Image, Modal, Popconfirm, Spin, message } from 'antd';
import { DeleteOutlined, FilePdfOutlined, FileUnknownOutlined } from '@ant-design/icons';
import { PdfPreview } from './PdfPreview';
import { usePreviewResource } from './usePreviewResource';
import { type AttachmentRef, type PreviewAdapter, previewError } from './types';

export function AttachmentThumb({file,adapter,size=72,onDelete,pdfThumbnail=true}:{file:AttachmentRef;adapter:PreviewAdapter;size?:number;onDelete?:(id:string)=>void;pdfThumbnail?:boolean}) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const {id,fileName,mimeType}=file;
  const pdf=mimeType==='application/pdf'||/\.pdf$/i.test(fileName);
  const photo=mimeType.startsWith('image/')||/\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(fileName);
  const load=useCallback(async(signal:AbortSignal,own:(blob:Blob)=>string)=>{
    if(pdf) return pdfThumbnail ? (await adapter.renderPdf({id,fileName,mimeType},signal,true))[0] || '' : '';
    if(!photo) return '';
    const url=own(await adapter.loadBlob({id,fileName,mimeType},signal));
    const img=new window.Image(); img.src=url;
    try { await img.decode(); } catch { throw new Error('图片损坏或格式不受支持'); }
    return url;
  },[adapter,id,fileName,mimeType,pdf,photo,pdfThumbnail]);
  const resource=usePreviewResource(load);
  const controller=useRef<AbortController>();
  useEffect(()=>()=>controller.current?.abort(),[]);
  function close(){setOpen(false);requestAnimationFrame(()=>trigger.current?.focus());}
  useEffect(()=>{
    if(!open)return;
    const esc=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopImmediatePropagation();close();}};
    window.addEventListener('keydown',esc,true);return ()=>window.removeEventListener('keydown',esc,true);
  },[open]);
  async function activate(){
    if(photo||pdf){setOpen(true);return;}
    controller.current?.abort();const c=new AbortController();controller.current=c;
    try {await adapter.download(file,c.signal);} catch(e){if(!c.signal.aborted)message.error(previewError(e));}
  }
  const container=()=>trigger.current?.closest('dialog') || document.body;
  return <div style={{display:'inline-grid',gap:4,width:size,maxWidth:'100%',position:'relative',verticalAlign:'top'}}>
    <button ref={trigger} type="button" aria-label={`${pdf?'预览 PDF':photo?'预览图片':'下载附件'}：${fileName}`} title={fileName}
      disabled={!pdf&&photo&&!resource.value} onClick={activate}
      style={{width:size,maxWidth:'100%',height:size,borderRadius:8,border:'1px solid #ccd6e0',padding:0,overflow:'hidden',background:'#f7f9fb',cursor:'pointer'}}>
      {resource.value ? <img src={resource.value} alt="" style={{display:'block',width:'100%',height:'100%',objectFit:pdf?'contain':'cover'}}/> :
       resource.error? <span>预览失败</span> : resource.value===undefined?<Spin size="small"/>:pdf?<FilePdfOutlined/>:<FileUnknownOutlined/>}
    </button>
    <small title={fileName} style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{fileName}</small>
    {resource.error && <span role="alert">{resource.error} <Button size="small" aria-label="重试" onClick={resource.retry}>重试</Button></span>}
    {onDelete&&<Popconfirm title="删除该附件？" onConfirm={()=>onDelete(id)}><Button size="small" aria-label="删除附件" style={{position:'absolute',right:2,top:2}} icon={<DeleteOutlined/>}/></Popconfirm>}
    {photo&&!pdf&&resource.value&&<Image style={{display:'none'}} wrapperStyle={{display:'none'}} src={resource.value} alt={fileName}
      preview={{visible:open,onVisibleChange:visible=>visible?setOpen(true):close(),getContainer:container,zIndex:12000}}/>}
    {pdf&&<Modal open={open} title={fileName} onCancel={close} footer={null} width="min(92vw, 1280px)" style={{top:12}} styles={{body:{padding:0}}} destroyOnClose getContainer={container} zIndex={12000}>
      {open&&<PdfPreview file={file} adapter={adapter}/>}
    </Modal>}
  </div>;
}
