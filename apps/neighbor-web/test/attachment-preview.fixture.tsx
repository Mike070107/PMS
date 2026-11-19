import React from 'react';
import { createRoot } from 'react-dom/client';
import { IntakeAttachment } from '../src/components/attachments/IntakeAttachment';
import { PdfPreview } from '../src/components/attachments/PdfPreview';
import { AttachmentThumb } from '../src/components/attachments/AttachmentThumb';
const root=createRoot(document.querySelector('#root')!);
const png=document.createElement('canvas');png.width=500;png.height=250;const ctx=png.getContext('2d')!;
ctx.fillStyle='#256db1';ctx.fillRect(0,0,500,250);ctx.fillStyle='#fff';ctx.fillText('Synthetic test',40,40);
const photo=await new Promise<Blob>(r=>png.toBlob(b=>r(b!)));
const w=window as any;
w.cleanup=()=>root.unmount();
const stub={async loadBlob(f:any,s:AbortSignal){
  if(!w.retried){w.retried=true;throw Object.assign(new Error(),{status:403});}
  return photo;
},async renderPdf(f:any,s:AbortSignal){
  if(w.empty)return [];
  return new Promise<string[]>((_,reject)=>s.addEventListener('abort',()=>{w.cancelled=true;reject(new Error('cancelled'));}));
},async download(){}};
const ref={id:'test',fileName:'边界.pdf',mimeType:'application/pdf'};
const mode=location.hash;
root.render(mode==='#error'?<AttachmentThumb adapter={stub} file={{...ref,fileName:'合成.png',mimeType:'image/png'}}/>:
 mode==='#empty'||mode==='#cancel'? (w.empty=mode==='#empty',<PdfPreview file={ref} adapter={stub}/>):
 <><IntakeAttachment file={new File([photo],'合成.png',{type:'image/png'})}/><IntakeAttachment file={{fileName:'合成.pdf',contentType:'application/pdf',fileUrl:'/synthetic.pdf'}}/></>);
