/**
 * 姓名 → 拼音首字母（「赵丽萍」→ zlp），用来给新员工自动生成登录账号。
 *
 * 为什么不装拼音库：这里只要首字母，而 `Intl.Collator('zh-Hans-CN')` 本来就是按拼音
 * 排序的 —— 拿 23 个「每个字母组里排最前面的那个字」当界桩，二分一下就知道某个字落在
 * 哪一组。零依赖、零数据表，Node 20 自带完整 ICU 就能跑。装一个库只为了取首字母，
 * 既让离线安装多一个包要同步到 C: 盘的 pnpm store，也没多解决什么问题。
 *
 * 界桩表是通行写法：i/u/v 没有对应的汉字声母，所以只有 23 个。
 */
const BOUNDARIES: ReadonlyArray<readonly [string, string]> = [
  ['A', '阿'], ['B', '八'], ['C', '嚓'], ['D', '咑'], ['E', '妸'],
  ['F', '发'], ['G', '旮'], ['H', '哈'], ['J', '丌'], ['K', '咔'],
  ['L', '垃'], ['M', '妈'], ['N', '拿'], ['O', '噢'], ['P', '趴'],
  ['Q', '七'], ['R', '然'], ['S', '仨'], ['T', '他'], ['W', '挖'],
  ['X', '夕'], ['Y', '丫'], ['Z', '匝'],
];

/**
 * 姓氏多音字。排序按的是**最常用**读音，姓氏往往不是那个读音：
 * 「曾」排在 c（曾经），做姓念 Zēng；「单」排在 d（单独），做姓念 Shàn。
 * 只在**第一个字**上生效 —— 名字里的「乐」多半还是 lè，不该当成姓氏的 Yuè。
 * 这张表实测出来的：凡是排序结果和姓氏读音不一致的都列在这里。
 */
const SURNAME_OVERRIDES: Readonly<Record<string, string>> = {
  曾: 'Z', 单: 'S', 解: 'X', 仇: 'Q', 区: 'O', 查: 'Z', 秘: 'B',
  折: 'S', 繁: 'P', 乐: 'Y', 重: 'C', 尉: 'Y', 翟: 'Z', 种: 'C',
};

const HAN = /[一-龥]/;
let collator: Intl.Collator | null = null;
const compare = (a: string, b: string) => {
  if (!collator) collator = new Intl.Collator('zh-Hans-CN');
  return collator.compare(a, b);
};

/** 单个汉字的拼音首字母（大写）。不是汉字返回空串 */
export function hanziInitial(char: string): string {
  if (!HAN.test(char)) return '';
  let hit = '';
  for (const [letter, anchor] of BOUNDARIES) {
    if (compare(char, anchor) >= 0) hit = letter;
    else break;
  }
  return hit;
}

/**
 * 姓名 → 小写首字母串。
 *
 * - 汉字取拼音首字母，第一个字先查姓氏多音字表；
 * - 本来就是英文/数字的原样保留（外籍同事、「Anna 王」这种混写）；
 * - 其余字符（空格、·、标点）一律丢掉。
 *
 * 认不出一个字母时返回空串，由调用方决定怎么兜底 —— 绝不编一个出来。
 */
export function nameToInitials(name: string): string {
  const value = String(name ?? '').trim();
  if (!value) return '';
  const chars = [...value];
  const out: string[] = [];
  chars.forEach((char, index) => {
    if (/[a-zA-Z0-9]/.test(char)) {
      out.push(char.toLowerCase());
      return;
    }
    if (!HAN.test(char)) return;
    // 姓氏多音字只认第一个字
    const override = index === 0 ? SURNAME_OVERRIDES[char] : undefined;
    const letter = override ?? hanziInitial(char);
    if (letter) out.push(letter.toLowerCase());
  });
  return out.join('');
}
