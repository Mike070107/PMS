import { randomInt } from 'node:crypto';

/**
 * 自动生成登录账号和初始密码。
 *
 * 为什么要有：物业新建用户时，管理员得自己想一个账号、再编一个密码，还要保证不重名 ——
 * 这几步没有一步需要人来判断，却每次都卡住他。现在系统直接给一组，他复制粘贴发给本人
 * 就完事（2026-09-14 Mike）。
 *
 * 账号 = 姓名拼音首字母；重名就依次加 01、02、03。
 */

/** 账号只留小写字母和数字；名字一个字母都认不出来时用它兜底 */
const FALLBACK_BASE = 'user';

export function normalizeAccountBase(raw: string): string {
  const value = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return value || FALLBACK_BASE;
}

/**
 * 从 base 开始挑一个没被占用的账号：base → base01 → base02 …
 *
 * 序号补到两位（01 而不是 1）：一眼看得出是「第几个重名的」，
 * 而且 zlp01 / zlp02 在名单里对得整齐，念给人听也不会漏掉零。
 * 超过 99 个重名就不补零了，那种规模本来也不该靠首字母区分。
 */
export function pickAvailableAccount(base: string, taken: Iterable<string>): string {
  const root = normalizeAccountBase(base);
  const used = new Set<string>();
  for (const item of taken) {
    const v = String(item ?? '').trim().toLowerCase();
    if (v) used.add(v);
  }
  if (!used.has(root)) return root;
  for (let i = 1; i <= 99; i += 1) {
    const candidate = `${root}${String(i).padStart(2, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let i = 100; i <= 999; i += 1) {
    const candidate = `${root}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // 同一个首字母挤了一千个人，已经不是取名问题了，给个随机尾巴别把创建卡死
  return `${root}${Date.now().toString(36).slice(-4)}`;
}

/**
 * 初始密码：念得出来、打得进去。
 *
 * 物业这边的人年纪偏大，密码是管理员在微信里发给他、他照着手打的 ——
 * 所以刻意避开 0/o、1/l/I 这些看不清的字符，用「辅音+元音」拼成两个能念的音节
 * 再跟 4 位数字，长度 8 位。纯随机串看着专业，实际会变成一堆「登不进去」的电话。
 */
const CONSONANTS = 'bcdfghjkmnpqrstvwxyz';
const VOWELS = 'aeu';
const DIGITS = '23456789';

export function generatePassword(): string {
  const pick = (pool: string) => pool[randomInt(pool.length)];
  let out = '';
  for (let i = 0; i < 2; i += 1) out += pick(CONSONANTS) + pick(VOWELS);
  for (let i = 0; i < 4; i += 1) out += pick(DIGITS);
  return out;
}
