import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import Vehicles from '@/pages/Vehicles';
import FamilyCars from '@/pages/FamilyCars';
import { Toaster } from '@/components/ui';
import ParkingTab from '@/components/cashier/ParkingTab';
import '@/styles/app.css';
import '@/styles/design.css';
import '@/styles/guards.css';
const onCart = () => undefined;
function Fixture() {
  const [mode, setMode] = useState('cashier');
  return <MemoryRouter><ConfigProvider locale={zhCN}><main style={{ padding: 12, maxWidth: 1100, margin: 'auto' }}>
    <Toaster />
    <p>车辆登记隔离验收 · 真实组件 / 合成接口 / 不连接生产</p>
    <div style={{ display: 'flex', gap: 8 }}><button id="cashier" className="btn" onClick={() => setMode('cashier')}>收银台入口</button><button id="vehicles" className="btn" onClick={() => setMode('vehicles')}>车辆页入口</button><button id="family" className="btn" onClick={() => setMode('family')}>亲情车期限</button></div>
    {mode === 'cashier' ? <ParkingTab house={{ id: 5, communityId: 3, lane: '228', buildingNo: '3', roomNo: '502' }} rules={[]} onCart={onCart} /> : mode === 'family' ? <FamilyCars /> : <Vehicles />}
  </main></ConfigProvider></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
