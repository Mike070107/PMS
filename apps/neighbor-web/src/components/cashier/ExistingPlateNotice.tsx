import { Link } from 'react-router-dom';
import Icon from '@/components/Icon';

export function isExistingPlateMessage(message: string) {
  return message.startsWith('该车牌已有登记，') ||
    message.startsWith('该车牌已有车辆档案，') ||
    message.startsWith('该车牌已有不兼容的登记，');
}

export default function ExistingPlateNotice({ plate }: { plate: string }) {
  const key = encodeURIComponent(plate);
  return <div className="note2" role="status" style={{ marginTop: 8 }}>
    <Icon name="alert" />
    <div>
      <div>{plate} 已有登记。核对原车和所属房产后，可继续分笔收款或办理不同期限。</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <Link className="btn" to={`/cashier?renewPlate=${key}`}>按原车续费</Link>
        <Link className="btn" to={`/records?q=${key}`}>查看收款流水</Link>
      </div>
    </div>
  </div>;
}
