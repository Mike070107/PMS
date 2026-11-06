import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConfigProvider} from 'antd';import zhCN from 'antd/es/locale/zh_CN';
import RenewSheet from '@/components/vehicle-ops/RenewSheet';
import {CarRenewal} from '@/components/cashier/ParkingTab';
import '@/styles/design.css';import '@/styles/guards.css';import '@/styles/calendar.css';
function Fixture(){const [mode,setMode]=useState('cashier'),[plate,setPlate]=useState('沪TEST01'),[cart,setCart]=useState<any>(null);
 const lot={key:'local1',targetKey:'local:phase1_parking',label:'一期地面',endDate:'2027-01-31',system:'local',ref:{system:'local',database:'parking1',sourceRecordId:'1',currentEndDate:'2027-01-31'}};
 const car:any={plate,identity:'住户车',lots:[lot],mismatch:null};
 const rule:any={id:1,communityId:1,serviceType:'parking_monthly',name:'隔离价格表',enabled:true,unitPriceCents:18000,config:{priceMode:'table',isDefault:true,tiers:[{months:1,amountCents:0},{months:2,amountCents:36000},{months:3,amountCents:54000},{months:6,amountCents:108000},{months:12,amountCents:180000}]}};
 return <ConfigProvider locale={zhCN}><main style={{padding:12,maxWidth:1000,margin:'auto'}}><h1>停车两入口 · 隔离验收</h1><p>真实组件 / 合成价格与车辆 / 不连接生产、不真实收费</p><div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}><button id="cashier" className="btn" onClick={()=>setMode('cashier')}>收银台续期</button><button id="vehicle" className="btn" onClick={()=>setMode('vehicle')}>车辆续期</button><button id="switch" className="btn" onClick={()=>setPlate(p=>p==='沪TEST01'?'沪TEST02':'沪TEST01')}>切换车辆</button></div>
 {mode==='cashier'?<><CarRenewal key={plate} car={car} rules={[rule]} house={{id:1,communityId:1} as any} onCart={(_,c)=>setCart(c)}/><output id="cart" style={{display:'block',overflowWrap:'anywhere'}}>{cart?JSON.stringify({months:cart.months,cents:cart.estimate.amountCents,endDate:cart.estimate.endDate}):'无可收款报价'}</output></>:<RenewSheet plate={plate} rows={[{database:'parking1',fields:{P_id:1,Car_Brand:'住户车',P_enddate:'2027-01-31'}}] as any} cloud={null} onClose={()=>setMode('cashier')} onDone={()=>{(window as any).__done=true}}/>}</main></ConfigProvider>;
}createRoot(document.getElementById('root')!).render(<Fixture/>);
