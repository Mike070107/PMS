import Icon, { type IconName } from '@/components/Icon';

/**
 * 收费项目的彩色图标（口径照公寓收费台那套配色：浅色圆角底 + 同色系图标）。
 * 项目名来自 MIS/账单，写法很杂，所以按关键词识别，识别不出来给中性色，
 * 绝不因为认不出就不显示图标。
 */
export type FeeTone = 'amber' | 'blue' | 'orange' | 'violet' | 'slate' | 'green' | 'brown' | 'pink';

interface FeeSkin { icon: IconName; tone: FeeTone }

const RULES: Array<[RegExp, FeeSkin]> = [
  [/热水/, { icon: 'fire', tone: 'orange' }],
  [/电费|用电|电卡|电表|能耗/, { icon: 'thunderbolt', tone: 'amber' }],
  [/水费|用水|冷水|自来水|水卡|污水/, { icon: 'flow', tone: 'blue' }],
  [/燃气|煤气|天然气/, { icon: 'fire', tone: 'orange' }],
  [/宽带|网络|网费|有线|电视|通讯/, { icon: 'globe', tone: 'violet' }],
  [/停车|泊位|车位|月租车位/, { icon: 'car', tone: 'slate' }],
  [/房租|租金|房屋租/, { icon: 'wallet', tone: 'green' }],
  [/押金|保证金|定金/, { icon: 'shield', tone: 'pink' }],
  [/垃圾|清运|保洁|卫生/, { icon: 'trash', tone: 'green' }],
  [/物业|管理费|公摊|公共能/, { icon: 'building', tone: 'brown' }],
  [/门禁|门卡|出入卡/, { icon: 'key', tone: 'blue' }],
  [/维修|报修|工本|材料/, { icon: 'wrench', tone: 'slate' }],
];

export function feeSkin(name?: string | null): FeeSkin {
  const text = (name ?? '').trim();
  for (const [re, skin] of RULES) if (re.test(text)) return skin;
  return { icon: 'receipt', tone: 'slate' };
}

/** 一行账单/流水前面的彩色小图标。 */
export function FeeIcon({ name, size = 32 }: { name?: string | null; size?: number }) {
  const { icon, tone } = feeSkin(name);
  return (
    <span className={`ic-tile t-${tone}`} style={{ width: size, height: size }} aria-hidden>
      <Icon name={icon} size={Math.round(size * 0.54)} />
    </span>
  );
}

export default FeeIcon;
