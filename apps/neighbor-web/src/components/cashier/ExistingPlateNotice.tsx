import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '@/components/Icon';
import { can } from '@/lib/perm';
import { request } from '@pms/api-client';
import type { Intake } from './NewPlateCard';

export function isExistingPlateMessage(message: string) {
  return message.startsWith('该车牌已有登记，') ||
    message.startsWith('该车牌已有车辆档案，') ||
    message.startsWith('该车牌已有不兼容的登记，');
}

export function ReleaseReversedRegistration({ intakeId, onReleased }: { intakeId: number; onReleased: (row: Intake) => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const release = async () => {
    setError(''); setBusy(true);
    try {
      const row = await request<Intake>({ method: 'POST', url: `/vehicle-intakes/${intakeId}/release-reversed`, data: { parkingChecked: checked } });
      onReleased(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : '处理登记失败，请重试');
    } finally { setBusy(false); }
  };
  return <div style={{ marginTop: 8 }}>
    <label><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} /> 已核对原车库，确认该车牌未入库</label>
    <div style={{ marginTop: 8 }}><button type="button" className="btn" disabled={!checked || busy} onClick={() => void release()}>{busy ? '处理中…' : '解除原登记占用'}</button></div>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export default function ExistingPlateNotice({ plate, intake, message }: { plate: string; intake: Intake; message: string }) {
  const [original, setOriginal] = useState<Intake | null>(null);
  const [released, setReleased] = useState(false);
  const key = encodeURIComponent(plate);
  useEffect(() => {
    if (message.startsWith('该车牌已有车辆档案，') || (intake.houseId == null && intake.shopBuildingId == null)) return;
    let active = true;
    const property = intake.shopBuildingId != null ? { shopBuildingId: intake.shopBuildingId } : { houseId: intake.houseId! };
    const normalize = (value: string) => value.replace(/[\s·.．・]/g, '').toUpperCase();
    void request<Intake[]>({ url: '/vehicle-intakes', query: { ...property, q: plate } }).then(rows => {
      if (active) setOriginal(rows.find(row => row.id !== intake.id && row.status !== 'void' && normalize(row.plate) === normalize(plate)
        && row.houseId === intake.houseId && (row.shopBuildingId ?? null) === (intake.shopBuildingId ?? null)) ?? null);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [plate, intake.id, intake.houseId, intake.shopBuildingId, message]);
  if (released) return <div className="note2 existing-plate-notice" role="status">原登记已解除占用，原资料和流水已保留。请重新保存本次资料。</div>;
  return <div className="note2 existing-plate-notice" role="status">
    <Icon name="alert" />
    <div>
      <div>{plate} 已有登记。{original?.canReleaseReversed ? '原收款已红冲。核实原车库未入库后，可解除原登记占用，再保存本次资料。' : '核对原登记或车辆档案后继续办理。'}</div>
      <div className="existing-plate-actions">
        {original && <Link className="btn" to={`/plates?intakeId=${original.id}`}>查看原登记</Link>}
        {!original?.canReleaseReversed && <Link className="btn" to={`/cashier?renewPlate=${key}`}>按原车续费</Link>}
        <Link className="btn" to={`/records?q=${key}`}>查看收款流水</Link>
      </div>
      {original?.canReleaseReversed && can('business', 'edit') && <ReleaseReversedRegistration intakeId={original.id} onReleased={() => setReleased(true)} />}
    </div>
  </div>;
}
