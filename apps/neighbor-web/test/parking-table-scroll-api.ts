// Synthetic transport only: this browser test never connects to production.
const rows = ['沪TEST01','沪TEST02'].map((plate,i)=>({database:'parking2',fields:{P_id:i+1,P_plate:plate,Owner__owner_Name:'228-11-1102',Car_Brand:'住户车-1',end_time:'2027-01-31 23:59:59',P_Effective:'000000001000001000000000',P_space:'A123'}}));
export const accessCardIssuance={createParkingQuery:async()=>({id:1,status:'completed',rows}),parkingQuery:async()=>({id:1,status:'completed',rows})};
export async function request<T>(o:{url:string}):Promise<T>{
 if(o.url==='/business/household-parking')return {room:'228/11/1102',localDatabases:['parking2'],targets:['枫桦景苑一期 地面车库','枫桦景苑二期 地面车库','枫桦景苑二期 大车库','枫桦景苑二期 人防车库'].map((label,i)=>({key:String(i),label})),deliyun:[]} as T;
 if(o.url==='/vehicle-intakes'||o.url==='/business/plate-tags')return [] as T;
 throw Error('Unexpected fixture request: '+o.url);
}
