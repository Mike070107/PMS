/**
 * 收款方式选择：微信/支付宝/现金三张大彩卡(官方 AntD 图标) + 「其他收款方式(可新增)」combobox。
 * 复用公寓收费台那套展示:常用三种一眼认色,银行/支票等冷门收进下拉,不再铺成一排重复图标的卡。
 * 收银台(value 存中文标签)与公寓收费台(value 存 code)共用。
 */
export interface PayOption { value: string; label: string }

const P_WECHAT = 'M690.1 377.4c5.9 0 11.8.2 17.6.5-24.4-128.7-158.3-227.1-319.9-227.1C209 150.8 64 271.4 64 420.2c0 81.1 43.6 154.2 111.9 203.6a21.5 21.5 0 019.1 17.6c0 2.4-.5 4.6-1.1 6.9-5.5 20.3-14.2 52.8-14.6 54.3-.7 2.6-1.7 5.2-1.7 7.9 0 5.9 4.8 10.8 10.8 10.8 2.3 0 4.2-.9 6.2-2l70.9-40.9c5.3-3.1 11-5 17.2-5 3.2 0 6.4.5 9.5 1.4 33.1 9.5 68.8 14.8 105.7 14.8 6 0 11.9-.1 17.8-.4-7.1-21-10.9-43.1-10.9-66 0-135.8 132.2-245.8 295.3-245.8zm-194.3-86.5c23.8 0 43.2 19.3 43.2 43.1s-19.3 43.1-43.2 43.1c-23.8 0-43.2-19.3-43.2-43.1s19.4-43.1 43.2-43.1zm-215.9 86.2c-23.8 0-43.2-19.3-43.2-43.1s19.3-43.1 43.2-43.1 43.2 19.3 43.2 43.1-19.4 43.1-43.2 43.1zm586.8 415.6c56.9-41.2 93.2-102 93.2-169.7 0-124-120.8-224.5-269.9-224.5-149 0-269.9 100.5-269.9 224.5S540.9 847.5 690 847.5c30.8 0 60.6-4.4 88.1-12.3 2.6-.8 5.2-1.2 7.9-1.2 5.2 0 9.9 1.6 14.3 4.1l59.1 34c1.7 1 3.3 1.7 5.2 1.7a9 9 0 006.4-2.6 9 9 0 002.6-6.4c0-2.2-.9-4.4-1.4-6.6-.3-1.2-7.6-28.3-12.2-45.3-.5-1.9-.9-3.8-.9-5.7.1-5.9 3.1-11.2 7.6-14.5zM600.2 587.2c-19.9 0-36-16.1-36-35.9 0-19.8 16.1-35.9 36-35.9s36 16.1 36 35.9c0 19.8-16.2 35.9-36 35.9zm179.9 0c-19.9 0-36-16.1-36-35.9 0-19.8 16.1-35.9 36-35.9s36 16.1 36 35.9a36.08 36.08 0 01-36 35.9z';
const P_ALIPAY = 'M512 64c247.42 0 448 200.58 448 448S759.42 960 512 960 64 759.42 64 512 264.58 64 512 64m32.5 168c-69.67 0-86.06 16.84-86.72 39.08l-.02 1.43v46.62H291.45c-9.92 0-14.28 23.05-14.27 39.3 0 2.7 2.08 4.93 4.77 4.93h175.81v58.3h-116.5c-9.96 0-14.3 23.76-14.27 39.47a4.77 4.77 0 004.77 4.76h233.45c-4.53 41.06-15.43 77.59-30.72 109.32l-1.22 2.5-.32-.28c-60.24-28.47-120.43-52.57-194.4-52.57l-2.62.01c-84.98 1.11-144.71 56.5-145.91 127.04l-.02 1.22.02 2.13c1.24 70.4 63.56 126.45 148.52 126.45 61.25 0 116.38-16.85 163.46-45.02a138.58 138.58 0 0014.07-7.96 345.6 345.6 0 0050.3-41.16l9.45 6.35 12.46 8.32c57.53 38.26 113.76 72.62 169.86 79.27a142.62 142.62 0 0018.31 1.16c43.02 0 55-52.68 57.39-95.51l.14-2.84c.4-8.46-6.2-15.6-14.65-15.86-75.46-2.37-136.45-22.05-192-46.11l-6.27-2.75c35.15-56.8 56.66-121.81 57.15-186.66l.09-1.08c.4-5.51-4-10.2-9.52-10.2H549.33v-58.3h165.73c9.92 0 14.28-22.12 14.27-39.31a4.85 4.85 0 00-4.78-4.92H549.32v-82.35a4.8 4.8 0 00-4.83-4.78M328 583.85c54.63 0 107.08 22.41 158.1 52.19l5.76 3.4c-103.57 119.84-247.17 95.9-261.72 26.37a66.89 66.89 0 01-1.14-9.83l-.06-2.34.02-.9c.97-40.12 45.33-68.9 99.04-68.9';
const P_CASH = 'M911.5 699.7a8 8 0 00-10.3-4.8L840 717.2V179c0-37.6-30.4-68-68-68H252c-37.6 0-68 30.4-68 68v538.2l-61.3-22.3c-.9-.3-1.8-.5-2.7-.5-4.4 0-8 3.6-8 8V762c0 3.3 2.1 6.3 5.3 7.5L501 909.1c7.1 2.6 14.8 2.6 21.9 0l383.8-139.5c3.2-1.2 5.3-4.2 5.3-7.5v-59.6c0-1-.2-1.9-.5-2.8zm-243.8-377L564 514.3h57.6c4.4 0 8 3.6 8 8v27.1c0 4.4-3.6 8-8 8h-76.3v39h76.3c4.4 0 8 3.6 8 8v27.1c0 4.4-3.6 8-8 8h-76.3V703c0 4.4-3.6 8-8 8h-49.9c-4.4 0-8-3.6-8-8v-63.4h-76c-4.4 0-8-3.6-8-8v-27.1c0-4.4 3.6-8 8-8h76v-39h-76c-4.4 0-8-3.6-8-8v-27.1c0-4.4 3.6-8 8-8h57L356.5 322.8c-2.1-3.8-.7-8.7 3.2-10.8 1.2-.7 2.5-1 3.8-1h55.7a8 8 0 017.1 4.4L511 484.2h3.3L599 315.4c1.3-2.7 4.1-4.4 7.1-4.4h54.5c4.4 0 8 3.6 8.1 7.9 0 1.3-.4 2.6-1 3.8z';

type Kind = 'wechat' | 'alipay' | 'cash';
const CORE: Array<{ kind: Kind; path: string; bg: string; evenOdd?: boolean }> = [
  { kind: 'wechat', path: P_WECHAT, bg: '#07c160' },
  { kind: 'alipay', path: P_ALIPAY, bg: '#1677ff', evenOdd: true },
  { kind: 'cash', path: P_CASH, bg: '#0e9f6e' },
];
function kindOf(key: string): Kind | null {
  const k = key.toLowerCase();
  if (key.includes('微信') || k.includes('wechat')) return 'wechat';
  if (key.includes('支付宝') || k.includes('alipay')) return 'alipay';
  if (key.includes('现金') || k.includes('cash')) return 'cash';
  return null;
}

export default function PayMethods({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: PayOption[] }) {
  // 三张常用卡(按 微信/支付宝/现金 固定顺序取 options 里对应项);其余进「其他」
  const coreOpts: Record<Kind, PayOption | undefined> = { wechat: undefined, alipay: undefined, cash: undefined };
  const others: PayOption[] = [];
  for (const o of options) {
    const k = kindOf(`${o.value}${o.label}`);
    if (k && !coreOpts[k]) coreOpts[k] = o;
    else others.push(o);
  }
  const cards = CORE.filter((c) => coreOpts[c.kind]).map((c) => ({ ...c, opt: coreOpts[c.kind]! }));
  const isOther = !cards.some((c) => c.opt.value === value);

  return (
    <>
      <div className="pm-grid">
        {cards.map((c) => {
          const on = !isOther && value === c.opt.value;
          return (
            <button type="button" key={c.kind} className={`pm-opt ${on ? 'on' : ''}`} onClick={() => onChange(c.opt.value)}>
              <span className="pm-ic" style={{ background: c.bg }}>
                <svg viewBox="64 64 896 896" width="28" height="28" fill="currentColor" aria-hidden>
                  <path d={c.path} fillRule={c.evenOdd ? 'evenodd' : undefined} />
                </svg>
              </span>
              <b>{c.opt.label}</b>
            </button>
          );
        })}
      </div>
      <div className="pm-other">
        <label>其他收款方式（可新增）</label>
        <input
          className="in"
          list="pm-other-list"
          value={isOther ? value : ''}
          placeholder="选择或输入收款方式"
          onChange={(e) => onChange(e.target.value)}
        />
        <datalist id="pm-other-list">
          {others.map((o) => <option key={o.value} value={o.label} />)}
        </datalist>
      </div>
    </>
  );
}
