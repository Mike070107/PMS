import {useEffect,useId,useRef,useState} from 'react';
import Icon from '@/components/Icon';
import {useUiPreferences} from '@/components/UiPreferencesProvider';
import {THEMES} from '@/lib/ui-preferences-core';
export default function ThemePicker({mobile=false}:{mobile?:boolean}){
 const [open,setOpen]=useState(false),ref=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),id=useId();
 const {preferences,palette,status,error,update,reload}=useUiPreferences();
 useEffect(()=>{
  if(!open)return;
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus()}};
  const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false)};
  window.addEventListener('keydown',key);window.addEventListener('pointerdown',outside);
  ref.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  return()=>{window.removeEventListener('keydown',key);window.removeEventListener('pointerdown',outside)};
 },[open]);
 return <div className={'personal-appearance'+(mobile?' appearance-mobile':'')} ref={ref}>
  <button ref={trigger} type="button" className="appearance-trigger" aria-label="切换主题色" aria-expanded={open} aria-controls={open?id:undefined} title="切换主题色" onClick={()=>setOpen(v=>!v)}><i className="theme-dot" style={{background:palette.primary}}/><span>切换主题色</span><Icon name="gear" size={18}/></button>
  {open&&<section id={id} className="appearance-panel" role="dialog" aria-label="切换主题色">
   <header><div><b>切换主题色</b><small>只对你的账号生效</small></div><button type="button" className="ib" aria-label="关闭主题色设置" onClick={()=>{setOpen(false);trigger.current?.focus()}}><Icon name="x"/></button></header>
   <p>主题色</p><div className="theme-options">{THEMES.map(t=><button type="button" className="theme-option" key={t.id} aria-pressed={preferences.theme===t.id} onClick={()=>void update({theme:t.id})}><i style={{background:t.primary}}>{preferences.theme===t.id&&<Icon name="check" size={19}/>}</i><span>{t.name}</span></button>)}</div>
   <p>左侧菜单</p><div className="sidebar-options"><button type="button" aria-pressed={!preferences.sidebarCollapsed} onClick={()=>void update({sidebarCollapsed:false})}>图标＋文字</button><button type="button" aria-pressed={preferences.sidebarCollapsed} onClick={()=>void update({sidebarCollapsed:true})}>紧凑图标</button></div>
   <div className={'appearance-status'+(status==='error'?' is-error':'')} role="status" aria-live="polite">{status==='saving'?'正在保存到你的账号…':status==='saved'?'已保存，重新打开仍会保留':status==='loading'?'正在读取你的配置…':error||'菜单背景与主色同步切换；业务状态与支付品牌色保持不变。'}</div>
   {status==='error'&&<button type="button" className="btn sm" onClick={()=>void reload()}>重新读取配置</button>}
  </section>}
 </div>;
}
