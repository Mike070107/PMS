export const THEMES = [
 {id:'slate',name:'经典钢蓝',primary:'#2d4e73',hover:'#223c59',soft:'#e9eff6',text:'#2b4a6d',link:'#3a648f'},
 {id:'ocean',name:'海青蓝',primary:'#176179',hover:'#10485b',soft:'#e7f2f6',text:'#16586e',link:'#216c84'},
 {id:'jade',name:'青松绿',primary:'#256659',hover:'#1b4d43',soft:'#e8f2ee',text:'#215c50',link:'#32796a'},
 {id:'indigo',name:'静谧靛紫',primary:'#575181',hover:'#423d65',soft:'#eeecf5',text:'#514a79',link:'#6b6196'},
 {id:'sand',name:'暖砂棕',primary:'#795b3b',hover:'#5d452c',soft:'#f5efe7',text:'#705335',link:'#896747'},
 {id:'rose',name:'雾玫瑰',primary:'#80546b',hover:'#634052',soft:'#f5ebf0',text:'#774e64',link:'#91647d'},
] as const;
export type UiTheme=typeof THEMES[number]['id'];
export interface UiPreferences {theme:UiTheme;sidebarCollapsed:boolean}
export interface PreferenceSnapshot {preferences:UiPreferences;status:'loading'|'idle'|'saving'|'saved'|'error';error:string}
export const DEFAULT_PREFERENCES:UiPreferences={theme:'slate',sidebarCollapsed:false};
export function normalizePreferences(raw:unknown):UiPreferences {
 const p=(raw&&typeof raw==='object'?raw:{}) as Record<string,unknown>;
 return {theme:THEMES.some(t=>t.id===p.theme)?p.theme as UiTheme:'slate',sidebarCollapsed:p.sidebarCollapsed===true};
}
export function preferenceKey(user:{id:number|string;tenantId?:number|string|null}|null):string {
 return user?`pms.ui.v1:${user.tenantId??'platform'}:${user.id}`:'pms.ui.v1:guest';
}
interface Dependencies {storage:Pick<Storage,'getItem'|'setItem'>|null;isCurrent:()=>boolean;load:()=>Promise<unknown>;save:(patch:Partial<UiPreferences>)=>Promise<unknown>}
function serverPreferences(raw:unknown):UiPreferences {
 if(!raw||typeof raw!=='object'||!THEMES.some(t=>t.id===(raw as any).theme)||typeof (raw as any).sidebarCollapsed!=='boolean')throw Error('个人配置返回异常');
 return normalizePreferences(raw);
}
/** 单账号实例。写请求串行；旧读取、旧账号或旧实例的响应不能改动新状态。 */
export function createPreferenceStore(key:string,deps:Dependencies){
 let confirmed={...DEFAULT_PREFERENCES};
 try{const cached=deps.storage?.getItem(key);if(cached)confirmed=normalizePreferences(JSON.parse(cached))}catch{/* 无本地存储仍走账号配置 */}
 let state:PreferenceSnapshot={preferences:confirmed,status:'idle',error:''};
 let active=true,epoch=0,revision=0,tail:Promise<unknown>=Promise.resolve();
 const listeners=new Set<()=>void>();
 const current=()=>active&&deps.isCurrent();
 function emit(next:PreferenceSnapshot){state=next;listeners.forEach(fn=>fn())}
 function cache(p:UiPreferences){try{deps.storage?.setItem(key,JSON.stringify(p))}catch{/* 数据库已保存，不把缓存受限当成保存失败 */}}
 async function start(){active=true;const turn=++epoch,rev=revision;emit({...state,status:'loading',error:''});try{
  if(!current())return;const loaded=serverPreferences(await deps.load());
  if(!current()||turn!==epoch||rev!==revision)return;
  confirmed=loaded;cache(loaded);emit({preferences:loaded,status:'idle',error:''});
 }catch{if(current()&&turn===epoch&&rev===revision)emit({...state,status:'error',error:'未能读取账号配置，当前使用本机已保存的外观；请重试。'})}}
 function update(patch:Partial<UiPreferences>):Promise<boolean>{
  if(!current())return Promise.resolve(false);
  const rev=++revision;
  emit({preferences:normalizePreferences({...state.preferences,...patch}),status:'saving',error:''});
  const task=tail.then(async()=>{
   if(!current())return false;
   try{
    const saved=serverPreferences(await deps.save(patch));
    if(!current())return false;
    confirmed=saved;cache(saved);
    if(rev===revision)emit({preferences:saved,status:'saved',error:''});
    return true;
   }catch{
    if(current()&&rev===revision)emit({preferences:confirmed,status:'error',error:'本次外观未保存，已恢复上次配置。请检查网络后重试。'});
    return false;
   }
  });
  tail=task;return task;
 }
 return {getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}},start,update,dispose:()=>{active=false;epoch++}};
}
