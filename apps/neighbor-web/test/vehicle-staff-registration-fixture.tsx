import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import NewPlateCard from '@/components/cashier/NewPlateCard';
import { CarRenewal } from '@/components/cashier/ParkingTab';
import { IconSprite } from '@/components/Icon';
import { seed, targets } from './vehicle-staff-registration-transport';
import '@/styles/design.css';
import '@/styles/app.css';
import '@/styles/erp-reference.css';
import '@/components/cashier/plate-review.css';
const rules: any[] = [{ id: 2, communityId: 3, enabled: true, serviceType: 'parking_monthly', name: '合成住户月租', unitPriceCents: 10000, config: { vehicleClass: '住户车-1', isDefault: true, parkingTargets: targets.map(t => t.key) } }];
for (const [i, vehicleClass] of ['租户车-2', '住户车-3', '产权车位', '租户车-1', '住户车-2'].entries()) rules.push({ ...rules[0], id: 20 + i, name: vehicleClass, config: { ...rules[0].config, vehicleClass, isDefault: false } });
const house: any = { id: 5, communityId: 3, communityName: '枫桦景苑二期', houseLabel: '228弄3号502', owner: { id: 8 } };
function App() {
  const [intake, setIntake] = useState(seed); const [cart, setCart] = useState<any>(null);
  (window as any).__rendered = intake; (window as any).__cart = cart;
  return <MemoryRouter><IconSprite/><main className="registration-workspace" style={{ maxWidth: 1180, margin: '0 auto', padding: 12 }}><h1>新车现场代登记</h1><p>合成浏览器回归 · 不写真实档案、不支付、不下发设备</p>
    <NewPlateCard intake={intake} house={house} rules={rules} targets={targets as any} onChange={setIntake} onDrop={() => {}} onCart={(_plate, c) => setCart(c)} renewal={(car, label, vehicleClass, onClass) => <CarRenewal car={car} rules={rules} house={house} onCart={(_plate, c) => setCart(c)} intakeId={intake.id} title="新办月租" label={label} vehicleClass={vehicleClass} onClass={onClass} />} />
    <output aria-label="本页收费清单">{cart ? `待收款 · 登记 ${cart.intakeId} · ${cart.months} 个月 · ${cart.estimate.amountCents / 100} 元` : '尚无待收款项目'}</output>
  </main></MemoryRouter>;
}
createRoot(document.getElementById('root')!).render(<App/>);
