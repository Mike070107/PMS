import Icon, { type IconName } from '@/components/Icon';
import type { FeeTone } from '@/components/FeeIcon';

/**
 * 业务类型 → 彩色图标。页面标题、分类入口、实体行共用一套，
 * 让每个业务在大类上有固定颜色（收费=暖、车辆=钢蓝、库存=绿、权限=紫…），
 * 不要每页各挑一个颜色。
 */
export type ToneKind =
  | 'cashier' | 'bills' | 'records' | 'fees' | 'standards' | 'meters'
  | 'vehicles' | 'plates' | 'cards' | 'devices'
  | 'workorders' | 'maintenance' | 'experience'
  | 'purchases' | 'stock' | 'materials'
  | 'houses' | 'owners' | 'staff' | 'offices'
  | 'intranet' | 'logs' | 'tasks' | 'settings' | 'dashboard' | 'income';

const SKIN: Record<ToneKind, { icon: IconName; tone: FeeTone }> = {
  cashier: { icon: 'wallet', tone: 'blue' },
  bills: { icon: 'receipt', tone: 'brown' },
  records: { icon: 'file', tone: 'slate' },
  fees: { icon: 'receipt', tone: 'slate' },
  standards: { icon: 'scale', tone: 'amber' },
  meters: { icon: 'flow', tone: 'blue' },
  vehicles: { icon: 'car', tone: 'slate' },
  plates: { icon: 'car', tone: 'slate' },
  cards: { icon: 'key', tone: 'blue' },
  devices: { icon: 'cpu', tone: 'slate' },
  workorders: { icon: 'wrench', tone: 'orange' },
  maintenance: { icon: 'clipboard', tone: 'brown' },
  experience: { icon: 'book', tone: 'violet' },
  purchases: { icon: 'clipboard', tone: 'brown' },
  stock: { icon: 'box', tone: 'green' },
  materials: { icon: 'layers', tone: 'violet' },
  houses: { icon: 'home', tone: 'brown' },
  owners: { icon: 'users', tone: 'green' },
  staff: { icon: 'users', tone: 'violet' },
  offices: { icon: 'building', tone: 'brown' },
  intranet: { icon: 'globe', tone: 'violet' },
  logs: { icon: 'log', tone: 'slate' },
  tasks: { icon: 'today', tone: 'green' },
  settings: { icon: 'gear', tone: 'slate' },
  dashboard: { icon: 'chart', tone: 'blue' },
  income: { icon: 'chart', tone: 'green' },
};

export function ToneIcon({ kind, size = 34 }: { kind: ToneKind; size?: number }) {
  const { icon, tone } = SKIN[kind] ?? SKIN.dashboard;
  return (
    <span className={`ic-tile t-${tone}`} style={{ width: size, height: size }} aria-hidden>
      <Icon name={icon} size={Math.round(size * 0.52)} />
    </span>
  );
}

export default ToneIcon;
