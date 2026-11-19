import { useEffect, useRef, useState } from 'react';
const clamp = (v:number) => Math.min(5,Math.max(.4,v));
export function usePreviewViewport() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{x:number;y:number;l:number;t:number} | null>(null);
  const [zoom,setZoom] = useState(1);
  const [size,setSize] = useState({width:840,height:700});
  useEffect(() => {
    const el = scrollRef.current!;
    const observer = new ResizeObserver(() => setSize({width:el.clientWidth,height:el.clientHeight}));
    observer.observe(el);
    function wheel(e: WheelEvent) { e.preventDefault(); setZoom(z=>clamp(+(z*(e.deltaY<0?1.1:.9)).toFixed(3))); }
    el.addEventListener('wheel',wheel,{passive:false});
    return () => { observer.disconnect(); el.removeEventListener('wheel',wheel); };
  }, []);
  return {scrollRef,size,zoom,adjust:(step:number)=>setZoom(z=>clamp(z+step)),reset:()=>setZoom(1), drag:{
    onPointerDown(e:React.PointerEvent<HTMLDivElement>) {
      if (e.button!==0 || (e.target instanceof Element && e.target.closest('button,a'))) return;
      dragRef.current={x:e.clientX,y:e.clientY,l:e.currentTarget.scrollLeft,t:e.currentTarget.scrollTop};
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e:React.PointerEvent<HTMLDivElement>) {
      const d=dragRef.current;
      if (d) { e.currentTarget.scrollLeft=d.l-e.clientX+d.x; e.currentTarget.scrollTop=d.t-e.clientY+d.y; }
    },
    onLostPointerCapture(){dragRef.current=null;},
  }};
}
