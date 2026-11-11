import React from 'react';
import {createRoot} from 'react-dom/client';
import ParkingTab from '@/components/cashier/ParkingTab';
import {IconSprite} from '@/components/Icon';
import '@/styles/design.css';import '@/styles/app.css';import '@/styles/large.css';import '@/styles/guards.css';import '@/styles/calendar.css';import '@/styles/erp-reference.css';import '@/components/cashier/mis-remarks.css';
const noop=()=>{};
createRoot(document.getElementById('root')!).render(<><IconSprite/><div id="web"><aside className="side">隔离浏览器验收</aside><div style={{padding:16,minWidth:0}}><div className="cash2"><div className="cashier-mis-bills"><ParkingTab house={{id:1,communityId:2,lane:'228',buildingNo:'11',roomNo:'1102'}} rules={[]} onCart={noop}/></div><aside className="card" style={{padding:16}}>本次办理（合成数据、不收费）</aside></div></div></div></>);
