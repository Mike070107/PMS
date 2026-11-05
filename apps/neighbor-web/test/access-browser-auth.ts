import type {ReactNode} from 'react';
export const session:any={token:'SYNTHETIC-NOT-A-CREDENTIAL',generation:1,user:{id:7,name:'隔离账号',tenantId:1},actingTenant:{id:1},access:{scopeAll:false,communityIds:[10],pages:{business:{view:true,edit:false}}}};
export const useSession=()=>session;export const can=(key:string,action='view')=>session.access?.pages?.[key]?.[action]===true;
export const auth={getUser:()=>session.user,getAccess:()=>session.access,captureIdentity:()=>({token:session.token,generation:session.generation}),isCurrent:(i:any)=>i.generation===session.generation,clear(){},setAccess(a:any){session.access=a}};
export function setPermissions(edit:boolean,view=true){session.generation++;session.access={...session.access,pages:{business:{edit,view}}}}
