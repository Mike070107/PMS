import { useMemo } from 'react';
import { AttachmentThumb } from './AttachmentThumb';
import type { AttachmentRef, PreviewAdapter } from './types';

type SavedFile = {fileName:string; fileUrl:string; contentType:string};
function adapterFor(local?:File): PreviewAdapter {
  async function loadBlob(file:AttachmentRef,signal:AbortSignal) {
    signal.throwIfAborted();
    if(local) return local;
    const url=new URL(file.id,location.href);
    if(url.origin!==location.origin) throw new Error('附件地址不属于当前站点');
    const response=await fetch(url,{signal,credentials:'same-origin'});
    if(!response.ok) throw Object.assign(new Error('附件读取失败'),{status:response.status});
    return response.blob();
  }
  return { loadBlob,
    async renderPdf(file,signal,firstOnly=false){
      const blob=await loadBlob(file,signal);
      if(blob.size>20*1024*1024)throw new Error('PDF 超过 20MB，请下载原文件');
      const pdf=await import('pdfjs-dist');
      pdf.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).href;
      const bytes=await blob.arrayBuffer(); signal.throwIfAborted();
      const task=pdf.getDocument({data:bytes,isEvalSupported:false,stopAtErrors:true});
      const cancel=()=>{void task.destroy();};
      signal.addEventListener('abort',cancel,{once:true});
      try {
        const doc=await task.promise;
        if(!firstOnly && doc.numPages>80)throw new Error('超过 80 页，请下载查看原文件');
        const pages:string[]=[];
        for(let n=1;n<=(firstOnly?Math.min(1,doc.numPages):doc.numPages);n++){
          signal.throwIfAborted();
          const page=await doc.getPage(n);const original=page.getViewport({scale:1});
          const viewport=page.getViewport({scale:Math.min(2,(firstOnly?192:1500)/Math.max(original.width,original.height))});
          const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          try {await page.render({canvas,viewport}).promise;pages.push(canvas.toDataURL('image/jpeg',.88));}
          finally {canvas.width=0;canvas.height=0;page.cleanup();}
        }
        return pages;
      } finally {signal.removeEventListener('abort',cancel);await task.destroy();}
    },
    async download(file,signal){
      const blob=await loadBlob(file,signal);signal.throwIfAborted();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download=file.fileName;a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
  };
}
const savedAdapter=adapterFor();
export function IntakeAttachment({file}:{file:SavedFile|File}) {
  const local=file instanceof File ? file : undefined;
  const adapter=useMemo(()=>local?adapterFor(local):savedAdapter,[local]);
  const ref:AttachmentRef=file instanceof File?{id:file.name,fileName:file.name,mimeType:file.type}:
    {id:file.fileUrl,fileName:file.fileName,mimeType:file.contentType};
  return <AttachmentThumb file={ref} adapter={adapter} size={88}/>;
}
