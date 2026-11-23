import { useState } from 'react';
import type { DeliyunVehicle, ParkingQueryRow } from '@pms/api-client/src/endpoints/access-card-issuance';
import Icon from '@/components/Icon';
import { can } from '@/lib/perm';
import VehicleTypeSheet from './VehicleTypeSheet';
import { ChangePlateSheet, DeleteSheet } from './OtherOpSheets';
import { RebindSheet, GaragesSheet } from './RebindGarageSheets';
import { HistorySheet, OwnerInfoSheet } from './HistoryAndOwnerSheets';

export default function VehicleActions({ plate, rows, cloud, onChanged }: {
  plate: string;
  rows: ParkingQueryRow[];
  cloud: DeliyunVehicle | 'loading' | null | undefined;
  onChanged: (plate?: string) => void;
}) {
  const [op, setOp] = useState<'vehicleType' | 'changePlate' | 'rebind' | 'garages' | 'history' | 'ownerInfo' | 'delete' | null>(null);
  const local = rows.filter(row => row.database === 'parking1' || row.database === 'parking2');
  const canDelete = can('business', 'edit') && local.length > 0 && new Set(local.map(row => row.database)).size === local.length;
  return <>
        <button className="btn sm" disabled={!can('business', 'edit')} onClick={() => setOp('vehicleType')}><Icon name="edit" size={15} />修改车辆类型</button>
        <button className="btn sm" disabled={!can('business', 'edit')} onClick={() => setOp('changePlate')}><Icon name="edit" size={15} />变更车牌</button>
        <button className="btn sm" onClick={() => setOp('rebind')}><Icon name="users" size={15} />变更绑定用户</button>
        <button className="btn sm" onClick={() => setOp('garages')}><Icon name="car" size={15} />调整车库授权</button>
        <button className="btn sm" onClick={() => setOp('history')}><Icon name="clock" size={15} />变更历史</button>
        <button className="btn sm" onClick={() => setOp('ownerInfo')}><Icon name="users" size={15} />更新住户资料</button>
        <button className="btn g sm" disabled={!canDelete} onClick={() => setOp('delete')}><Icon name="trash" size={15} />注销车辆</button>
      {op === 'vehicleType' ? <VehicleTypeSheet plate={plate} rows={rows} onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} /> : null}
      {op === 'changePlate' ? (
        <ChangePlateSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={(t) => { setOp(null); onChanged(t); }} />
      ) : null}
      {op === 'rebind' ? (
        <RebindSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'garages' ? (
        <GaragesSheet plate={plate} rows={rows} cloud={cloud}
          onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'history' ? (
        <HistorySheet plate={plate} rows={rows} onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'ownerInfo' ? (
        <OwnerInfoSheet plate={plate} rows={rows} onClose={() => setOp(null)} onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
      {op === 'delete' && canDelete ? (
        <DeleteSheet plate={plate} rows={rows} cloud={cloud} onClose={() => setOp(null)}
          onDone={() => { setOp(null); onChanged(); }} />
      ) : null}
  </>;
}
