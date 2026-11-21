import { maskPhone } from '@/lib/format';
import type { ParkHouse } from './ParkingTab';

export const registrationTitle = (kind: 'paid'|'family') => kind === 'family' ? '亲情车办理申请单' : '新车登记申请单';

export default function RegistrationPermit({ house, intakeId, kind }: { house: ParkHouse; intakeId?: number; kind?: 'paid'|'family' }) {
  return <header className="registration-house" aria-label="登记住户">
    <span className="permit-sign" aria-hidden="true">P</span>
    <div className="permit-resident"><small>登记住户</small><strong>{[house.communityName || house.lane, house.buildingNo + '/' + house.roomNo].filter(Boolean).join(' · ')}</strong><span>{house.owner?.name || '未登记业主'}　{maskPhone(house.owner?.phone)}</span></div>
    {intakeId != null && kind && <strong className="permit-application-title">{registrationTitle(kind)}</strong>}
    {intakeId != null && <div className="permit-stub"><small>登记编号</small><b>#{intakeId}</b></div>}
  </header>;
}
