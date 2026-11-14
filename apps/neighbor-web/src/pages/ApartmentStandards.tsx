import { FeeTemplatesSection } from '@/components/settings/feeTemplates';
import { can } from '@/lib/perm';
import ToneIcon from '@/components/ToneIcon';

/** 与系统设置使用同一套模板、版本、住户套用和权限；不是新的收费引擎。 */
export default function ApartmentStandards() {
  return <>
    <div className="h1row"><ToneIcon kind="fees" /><h1>公寓收费标准</h1></div>
    <p className="muted">按公寓分别配置收费项目与价格，再套用到房间。员工选房、选项目后自动带价；修改标准不改写历史收据。</p>
    <FeeTemplatesSection canEdit={can('settings','edit')} initialKind="apartment" onlyKind />
  </>;
}
