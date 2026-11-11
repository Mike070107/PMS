import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import Vehicles from '@/pages/Vehicles';
import Plates from '@/pages/Plates';
import Cashier from '@/pages/Cashier';
import { IconSprite } from '@/components/Icon';
import '@/styles/design.css';
import '@/styles/app.css';
import '@/styles/large.css';
import '@/styles/guards.css';
import '@/styles/erp-reference.css';
function Fixture() {
  const navigate = useNavigate();
  (window as any).__navigate = navigate;
  return <main style={{ padding: 16, maxWidth: 1400, margin: '0 auto' }}><IconSprite/><p>显式 Mock transport · 合成住户 · 禁止真实 API / MIS / SQL / 设备</p><Routes><Route path="/vehicles" element={<Vehicles/>}/><Route path="/plates" element={<Plates/>}/><Route path="/cashier" element={<Cashier/>}/></Routes></main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture/></BrowserRouter>);
