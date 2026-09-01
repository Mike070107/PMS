import { missingChars } from '../../fonts/coverage';
import type { MaintenanceOrder } from './types';

/**
 * 养护单「填写内容」用的手写体。
 *
 * 这几款字体是**我们自己发出去的网页字体**（woff2），不是本机字体 ——
 * 物业办公室那些机器装不了字体（要管理员权限），也不该要求他们装。
 * 浏览器第一次用到时下载一次，之后走 30 天 immutable 缓存（nginx 对 /assets/ 的规则），
 * 换台电脑也只是再下一次。
 *
 * 字体文件由 tools/fonts/build-webfonts.py 从 src/ttf/ 的原始 TTF 转出，
 * @font-face 声明在 maintenance-sheet.css 里（那份 CSS 同时供屏幕预览和打印 iframe 用，
 * 声明写在别处打印就没字体了）。
 */
export interface HandwritingFont {
  /** 与 woff2 文件名、coverage.ts 的键一致；'system' 是不下载的那一档 */
  id: string;
  label: string;
  /** 下拉里跟在名字后面的一句话：多大、什么手感、适合什么 */
  desc: string;
  /** 下载体积（MB，十进制，和浏览器显示的一致）；系统字体没有 */
  sizeMb?: number;
  /** CSS 里的 font-family 名，用来判断「下载完了没有」；系统字体没有 */
  family?: string;
  /**
   * 下拉选项里预览用的字体名 —— 只切了选项那几十个字的迷你版（8–18KB）。
   * 预览必须用它，不能直接用 family：下拉一展开每一项都会用到自己那款字，
   * 用完整字体等于看一眼列表就下 14MB。
   */
  previewFamily?: string;
}

export const HANDWRITING_FONTS: HandwritingFont[] = [
  {
    id: 'zhaizaijia',
    label: '宅在家自动笔',
    desc: '工整清楚，生僻字最全（2 万字）',
    sizeMb: 5.7,
    family: 'MOZhaizaijia',
    previewFamily: 'MOZhaizaijiaP',
  },
  {
    id: 'zhangqingping',
    label: '张清平硬笔行书',
    desc: '钢笔字，最像人手填的',
    sizeMb: 2.9,
    family: 'MOZhangqingping',
    previewFamily: 'MOZhangqingpingP',
  },
  {
    id: 'wanweiwei',
    label: '我爱万伟伟手写体',
    desc: '随意些的圆珠笔字',
    sizeMb: 1.7,
    family: 'MOWanweiwei',
    previewFamily: 'MOWanweiweiP',
  },
  {
    id: 'shoushu',
    label: '手书体',
    desc: '连笔多，偏草',
    sizeMb: 3.8,
    family: 'MOShoushu',
    previewFamily: 'MOShoushuP',
  },
  {
    id: 'system',
    label: '系统自带（不下载）',
    desc: '用打印这台电脑上的行楷/楷体',
  },
];

export const DEFAULT_FONT_ID = 'zhaizaijia';

const FONT_KEY = 'pms.maintenance.handFont';

export function findFont(id: string | null | undefined): HandwritingFont {
  return (
    HANDWRITING_FONTS.find((font) => font.id === id) ??
    HANDWRITING_FONTS.find((font) => font.id === DEFAULT_FONT_ID)!
  );
}

export function readFontId(): string {
  try {
    const saved = localStorage.getItem(FONT_KEY);
    if (saved && HANDWRITING_FONTS.some((font) => font.id === saved)) return saved;
  } catch {
    // 隐私模式下读不了，用默认的就行
  }
  return DEFAULT_FONT_ID;
}

export function rememberFontId(id: string): void {
  try {
    localStorage.setItem(FONT_KEY, id);
  } catch {
    // 同上
  }
}

/**
 * 单子上会**用手写体印出来的**那些字。
 *
 * 只收这些字段，不是图省事地 JSON.stringify 整个对象：编号、状态、签名图 URL 这些
 * 要么不上纸、要么根本不是中文，混进来只会让「缺字提示」误报。
 */
export function filledText(order: MaintenanceOrder | null | undefined): string {
  if (!order) return '';
  const parts: (string | null | undefined)[] = [
    order.unitName,
    order.reporterName,
    order.addrVillage,
    order.addrRoad,
    order.addrLane,
    order.addrBuildingNo,
    order.addrRoom,
    order.addressText,
    order.presentTime,
    order.faultPart,
    order.repairItem,
    order.repairDateText,
    order.feeCategoryText,
    order.shareMethodText,
    order.voucherIssue,
    order.scrapNote,
    order.serviceRecord,
    order.followUpRecord,
    order.fillerName,
    order.repairerName,
    order.inspectorName,
  ];
  for (const item of order.items ?? []) {
    parts.push(item.part, item.name, item.quality, item.note);
  }
  for (const material of order.materials ?? []) {
    parts.push(material.name, material.spec, material.unit, material.note);
  }
  return parts.filter(Boolean).join('');
}

/** 这张单上有哪些字这款字体没有 —— 有的话浏览器会悄悄掉回宋体，纸上就是两种字 */
export function missingForOrder(fontId: string, order: MaintenanceOrder | null | undefined): string[] {
  const font = findFont(fontId);
  if (!font.family) return [];
  return missingChars(font.id, filledText(order));
}

/**
 * 等字体下载完。
 *
 * 打印**必须**等这一步：woff2 是 font-display:swap，没下完就打会先用宋体顶上，
 * 一张联单就废了。document.fonts.load 只在字体真的没下过时才发请求，缓存命中就立刻 resolve。
 */
export async function ensureFontLoaded(fontId: string, sample: string): Promise<void> {
  const font = findFont(fontId);
  if (!font.family || typeof document === 'undefined' || !document.fonts) return;
  // 字号随便给一个：FontFaceSet 按 family 匹配，size 只是必填的语法成分
  await document.fonts.load(`700 13px "${font.family}"`, sample || '养护单');
}
