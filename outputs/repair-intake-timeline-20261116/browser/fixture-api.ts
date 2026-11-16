// Isolated synthetic boundary only. No PMS API, database, storage or notifications.
const tree = [
 {id:81,name:'合成空楼小区',mainLane:null,isGroup:false,buildings:[]},
 {id:82,name:'合成永南140弄',mainLane:'140',isGroup:false,buildings:[{id:821,buildingNo:'6',lane:'140',houses:[{id:8211,roomNo:'502',ownerName:'合成住户',ownerPhone:'13800138000',ownerId:9}]}]},
];
async function api(path:string,data?:unknown){
 const r=await fetch('/fixture-api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 const b=await r.json(); if(!r.ok) throw new Error(b.message); return b;
}
export const address={tree:async()=>tree};
export const repairs={
 locationSuggestions:async()=>({items:[{text:'大门',count:3}]}),
 create:(data:unknown)=>api('create',data),
 detail:(id:number)=>api('detail?id='+id),
 stockOptions:async()=>({warehouses:[],materials:[]}),
 technicians:async()=>[],
};
