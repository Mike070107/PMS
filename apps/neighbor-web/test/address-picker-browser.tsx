// Isolated real-browser fixture: no API or authentication; all data is explicit test data.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import HousePicker from '../src/components/HousePicker';
import AddressSearch from '../src/components/AddressSearch';
import UniSearch from '../src/components/cashier/UniSearch';
const communities: any[] = [{id:1,name:'测试一期',mainLane:'198',buildings:[{id:11,lane:'198',buildingNo:'2',houses:[{id:111,roomNo:'201',ownerName:'甲'}]}]},{id:2,name:'测试二期',mainLane:'228',buildings:[{id:22,lane:'228',buildingNo:'6',houses:[{id:222,roomNo:'502',ownerName:'乙'}]}]}];
function Fixture(){
 const [query,setQuery]=useState(''),[house,setHouse]=useState<any>(null),[pub,setPub]=useState<any>(null);
 return <div style={{padding:20,maxWidth:900}}>
 <section id="house"><HousePicker communities={communities} value={house} publicValue={pub} allowPublicArea onPick={p=>{setHouse(p);setPub(null)}} onPublicPick={p=>{setPub(p);setHouse(null)}} onIncomplete={()=>{setHouse(null);setPub(null)}}/></section>
 <section id="list"><AddressSearch communities={communities} value={query} onChange={setQuery}/><output>{query}</output></section>
 <section id="uni"><UniSearch communities={communities} onPick={p=>{(window as any).picked=p}} search={async term=>{
  (window as any).terms=[...((window as any).terms||[]),term];
  const houses=communities.flatMap(c=>c.buildings.flatMap((b:any)=>b.houses.map((h:any)=>({id:h.id,communityId:c.id,communityName:c.name,lane:b.lane,buildingNo:b.buildingNo,roomNo:h.roomNo,owner:null}))));
  return {houses:term.includes('228')?houses.filter(h=>h.communityId===2):term.includes('198')?houses.filter(h=>h.communityId===1):[],vehicles:term==='沪TEST'? [{id:5,houseId:111,plateNo:'沪TEST'}]:[],accessCards:[]};
 }}/></section>
 <button id="outside">其他输入焦点</button>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
