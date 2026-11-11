import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import NewPlateCard, { type Intake } from '@/components/cashier/NewPlateCard';
import { IconSprite } from '@/components/Icon';
import { seed, targets } from './vehicle-intake-actions-transport';
import '@/styles/design.css';
import '@/styles/app.css';
import '@/styles/large.css';
import '@/styles/guards.css';
import '@/styles/erp-reference.css';
function Fixture() {
  const [it, setIt] = useState(seed as Intake);
  (window as any).__rendered = it;
  return <main style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}><IconSprite/><p>显式本地合成 · 真实 React 生产组件 · 禁止真实 API / MIS / SQL / 设备</p><NewPlateCard intake={it} house={{ id: 1, lane: '198', buildingNo: '示例', roomNo: '示例' } as any} rules={[]} targets={targets as any} manage onChange={setIt} onDrop={() => {}} onCart={() => {}} renewal={() => null}/></main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture/></BrowserRouter>);
