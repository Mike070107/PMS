import { maskPhone } from '@/lib/format';
import type { ParkHouse } from './ParkingTab';

export default function RegistrationPermit({ house, intakeId }: { house: ParkHouse; intakeId?: number }) {
  return <header className="registration-house" aria-label="登记住户">
    <span className="permit-sign" aria-hidden="true">P</span>
    <div className="permit-resident"><small>登记住户</small><strong>{[house.communityName || house.lane, house.buildingNo + '/' + house.roomNo].filter(Boolean).join(' · ')}</strong><span>{house.owner?.name || '未登记业主'}　{maskPhone(house.owner?.phone)}</span></div>
    {intakeId != null && <div className="permit-stub"><small>登记编号</small><b>#{intakeId}</b></div>}
  </header>;
}
