import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import NewOrderSheet from '@/components/NewOrderSheet';
import WorkOrderSheet from '@/components/WorkOrderSheet';
import PhotoField from '@/components/PhotoField';
import {IconSprite} from '@/components/Icon';
import {Toaster} from '@/components/ui';
import '@/styles/design.css';
import '@/styles/app.css';
import '@/styles/large.css';
import '@/styles/guards.css';
import '@/styles/erp-reference.css';
const fixed=new URLSearchParams(location.search).has('fixed')?{communityId:82,addressText:'合成永南140弄6号502室',contactName:'预填联系人'}:null;
function Fixture(){
 const reloadDetail=new URLSearchParams(location.search).has('detail');
 const [open,setOpen]=useState(!reloadDetail),[id,setId]=useState<number|null>(reloadDetail?901:null),[other,setOther]=useState<string[]>([]);
 const multi=new URLSearchParams(location.search).has('multi');
 return <><IconSprite/><Toaster/><div id="web"><section className="main"><div className="content">
 <h1>隔离报修交互验收 · 合成数据</h1><button style={{position:'fixed',left:10,top:10,zIndex:99999}} onClick={()=>{setOpen(true);setId(null)}}>重新登记</button>
 {multi&&<section id="other-photos" aria-label="第二上传区" style={{position:'fixed',zIndex:9999,left:10,top:100,background:'white',padding:12}}><h2>第二上传区</h2><PhotoField value={other} onChange={setOther}/><output>{JSON.stringify(other)}</output></section>}
 <NewOrderSheet initialHouse={fixed} open={open} onClose={()=>setOpen(false)} onCreated={wid=>{setOpen(false);setId(wid)}}/>
 <WorkOrderSheet id={id} onClose={()=>setId(null)} onChanged={()=>{}}/>
 </div></section></div></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
