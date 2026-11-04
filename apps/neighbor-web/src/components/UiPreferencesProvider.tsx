import {createContext,useContext,useEffect,useLayoutEffect,useMemo,useSyncExternalStore,type ReactNode} from 'react';
import {ConfigProvider} from 'antd';
import {request} from '@pms/api-client';
import {auth,useSession} from '@/lib/auth';
import {createPreferenceStore,DEFAULT_PREFERENCES,preferenceKey,THEMES,type UiPreferences,type PreferenceSnapshot} from '@/lib/ui-preferences-core';
import '@/styles/ui-preferences.css';
type UiContext=PreferenceSnapshot&{palette:typeof THEMES[number];update:(patch:Partial<UiPreferences>)=>Promise<boolean>;reload:()=>Promise<void>};
const Context=createContext<UiContext|null>(null);
function PreferenceSession({identity,loggedIn,children}:{identity:string;loggedIn:boolean;children:ReactNode}){
 const store=useMemo(()=>{
  let storage:Storage|null=null;try{storage=window.localStorage}catch{/* 隐私模式可只使用服务器 */}
  return createPreferenceStore(identity,{storage,isCurrent:()=>preferenceKey(auth.getUser())===identity,
   load:()=>loggedIn?request<UiPreferences>({url:'/auth/ui-preferences'}):Promise.resolve(DEFAULT_PREFERENCES),
   save:patch=>request<UiPreferences>({url:'/auth/ui-preferences',method:'PATCH',data:patch}),
  });
 },[identity,loggedIn]);
 const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
 const palette=THEMES.find(t=>t.id===snapshot.preferences.theme)??THEMES[0];
 useLayoutEffect(()=>{
  const root=document.documentElement;root.dataset.uiTheme=palette.id;
  for(const [key,value] of Object.entries({'--acc':palette.primary,'--acc-h':palette.hover,'--acc-w':palette.soft,'--acc-t':palette.text,'--acc-b':palette.link}))root.style.setProperty(key,value);
 },[palette]);
 useEffect(()=>{void store.start();return()=>store.dispose()},[store]);
 return <Context.Provider value={{...snapshot,palette,update:store.update,reload:store.start}}><ConfigProvider theme={{token:{colorPrimary:palette.primary,fontSize:16,controlHeight:44,borderRadius:8}}}>{children}</ConfigProvider></Context.Provider>;
}
export default function UiPreferencesProvider({children}:{children:ReactNode}){
 const session=useSession(),identity=preferenceKey(session.user);
 return <PreferenceSession key={identity} identity={identity} loggedIn={!!session.token}>{children}</PreferenceSession>;
}
export function useUiPreferences(){const c=useContext(Context);if(!c)throw Error('缺少个人外观上下文');return c}
