# -*- coding: utf-8 -*-
"""
把 src/ttf/ 下的手写字体转成网页字体（woff2），输出到 apps/admin-web/src/fonts/。

为什么要有这一步：
  · 养护单填写内容用的是手写体，**不能指望打印那台电脑装了这些字体** —— 装字体要管理员权限，
    物业办公室的机器一台都装不动。转成 woff2 由我们自己的站点发出去，浏览器下完就能用。
  · 原始 TTF 一共 40MB（单个最大 18MB），直接挂网上没法用。woff2 是 Brotli 压过的字体格式，
    同一套字形只有原来的 1/3～1/4，而且所有现代浏览器都认（IE 才不认，早不用管了）。

一并做掉的瘦身（不影响印出来的样子）：
  · --no-hinting / 丢掉 prep,fpgm,cvt,gasp,hdmx,LTSH,VDMX：这些是低分辨率屏幕上的字形微调表，
    打印和高清屏都用不到，中文字体里却占体积。
  · --desubroutinize：展开 CFF 子程序，woff2 自己的压缩比子程序更划算。
  · 只保留常用 Unicode 段（ASCII + 汉字 + 中英文标点 + 常见符号），
    去掉假名、韩文、注音这些单据上不会出现的区段。

用法（装好依赖后在仓库根目录跑）：
    python -m pip install fonttools brotli
    python tools/fonts/build-webfonts.py

字体授权由 Mike 提供，源 TTF 不进仓库（40MB），转好的 woff2 进。
"""
import os
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'src', 'ttf')
OUT = os.path.join(ROOT, 'apps', 'admin-web', 'src', 'fonts')

# 源文件名 -> 输出文件名（输出一律 ASCII，中文文件名在 nginx/tar/git 上都容易出岔子）
FONTS = {
    'ShouShuTi-2.ttf': 'shoushu.woff2',
    'ZhaiZaiJiaZiDongBi-2.ttf': 'zhaizaijia.woff2',
    '我爱万伟伟手写体.ttf': 'wanweiwei.woff2',
    '瑞美加张清平硬笔行书.ttf': 'zhangqingping.woff2',
}

# 故意不收的：
#   ChenYuluoyan-Thin.ttf（辰宇落雁体）—— **繁体字体**。它的字表里「報養護單員業經費體電設
#   區門頂牆線開關燈龍頭馬戶鎖換樓強」一个不缺，简体的「报养护单员业经费体电设区门顶墙线开关
#   灯龙头马户锁换楼强」一个不有。拿它填简体单据，一小半的字会掉回系统宋体，纸上花花绿绿。
#   要这个味道得另找简体版。

# 单据上可能出现的字符区段：拉丁、通用标点、中文标点、汉字（基本区 + 扩展A）、全角、
# 带圈数字、箭头、数学符号、常见单位符号（℃ ㎡ №）
UNICODES = ','.join([
    'U+20-7E', 'U+A0-FF', 'U+2000-206F', 'U+3000-303F',
    'U+4E00-9FFF', 'U+3400-4DBF', 'U+FF00-FFEF',
    'U+2460-24FF', 'U+2190-21FF', 'U+2200-22FF',
    'U+00B7', 'U+00D7', 'U+2103', 'U+2116', 'U+339C-33A1',
])

# 下拉里「用这款字体写出它自己的名字」那一行要用的字。
# 单独切一份几 KB 的预览字体，是因为下拉一展开就会用到**每一款** ——
# 直接用完整字体的话，光是看一眼列表就要下 14MB（线上实测过，四个文件全被拉下来了）。
PREVIEW_TEXT = '张清平硬笔行书我爱万伟伟手写体宅在家自动笔系统自带不下载修换声控灯王小明0123456789.·（）'

# 汉字基本区：单据上出现的字 99.9% 落在这一段（扩展 A/B 是古籍生僻字，这几款字体本来也没有）
CJK_LO, CJK_HI = 0x4E00, 0x9FFF

HEADER = """/* 由 tools/fonts/build-webfonts.py 生成，别手改。
 *
 * 每款手写体「有哪些汉字」的位图（U+4E00–U+9FFF 逐位，base64）。
 * 手写体大多只做到 GB2312 的 6763 字，姓名里的生僻字（喆、珺、燊、玥、垚…）没有，
 * 浏览器会悄悄掉回系统宋体 —— 屏幕上不细看发现不了，打到纸上就是两种字。
 * 填单页拿它当场提示缺哪几个字，别等印坏了一张联单才发现。
 */
const CJK_LO = 0x4e00;
const CJK_HI = 0x9fff;

const COVERAGE: Record<string, string> = {
"""

FOOTER = """
};

const decoded = new Map<string, Uint8Array>();

function bitmapOf(fontFile: string): Uint8Array | null {
  const cached = decoded.get(fontFile);
  if (cached) return cached;
  const b64 = COVERAGE[fontFile];
  if (!b64) return null;
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  decoded.set(fontFile, bytes);
  return bytes;
}

/** 这款字体有没有这个字。位图之外的字符（数字、标点、扩展区汉字）一律当作有。 */
export function fontHasChar(fontFile: string, ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined || code < CJK_LO || code > CJK_HI) return true;
  const bits = bitmapOf(fontFile);
  if (!bits) return true;
  const idx = code - CJK_LO;
  return (bits[idx >> 3] & (1 << (idx & 7))) !== 0;
}

/** 这段文字里这款字体缺哪些字（去重、保持出现顺序）。 */
export function missingChars(fontFile: string, text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    if (!fontHasChar(fontFile, ch)) out.push(ch);
  }
  return out;
}
"""


def build_one(src: str, dst: str) -> None:
    subset.main([
        src,
        '--unicodes=' + UNICODES,
        '--layout-features=*',
        '--flavor=woff2',
        '--desubroutinize',
        '--no-hinting',
        '--drop-tables+=FFTM,PfEd,TSI0,TSI1,TSI2,TSI3,TSI5,prep,fpgm,cvt,gasp,hdmx,LTSH,VDMX',
        '--name-IDs=*',
        '--notdef-outline',
        '--output-file=' + dst,
    ])


def build_preview(src: str, dst: str) -> None:
    subset.main([
        src,
        '--text=' + PREVIEW_TEXT,
        '--layout-features=',
        '--flavor=woff2',
        '--desubroutinize',
        '--no-hinting',
        '--name-IDs=*',
        '--notdef-outline',
        '--output-file=' + dst,
    ])


def write_coverage() -> None:
    """
    生成 coverage.ts：每款字体一张「这个字有没有」的位图。

    位图按 U+4E00–U+9FFF 逐位存（20992 位 = 2624 字节），base64 之后每款约 3.5KB，
    四款一共 14KB —— 比任何一种「码点列表」都小，查一个字也只是一次位运算。
    """
    import base64
    lines = []
    for out_name in sorted(set(FONTS.values())):  # 覆盖位图只按完整字体算，预览字体不参与
        font = TTFont(os.path.join(OUT, out_name), lazy=True)
        cmap = font.getBestCmap()
        bits = bytearray((CJK_HI - CJK_LO + 1 + 7) // 8)
        for code in cmap:
            if CJK_LO <= code <= CJK_HI:
                idx = code - CJK_LO
                bits[idx >> 3] |= 1 << (idx & 7)
        font.close()
        key = out_name.replace('.woff2', '')
        b64 = base64.b64encode(bytes(bits)).decode('ascii')
        lines.append("  %s:%s    '%s'," % (key, chr(10), b64))
    path = os.path.join(OUT, 'coverage.ts')
    with open(path, 'w', encoding='utf-8', newline=chr(10)) as fh:
        fh.write(HEADER + chr(10).join(lines) + FOOTER)
    print('coverage.ts  %.1fKB' % (os.path.getsize(path) / 1024))


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    missing = [name for name in FONTS if not os.path.exists(os.path.join(SRC, name))]
    if missing:
        print('缺少源字体（放到 src/ttf/ 下再跑）：' + '、'.join(missing))
        return 1
    for name, out_name in FONTS.items():
        src = os.path.join(SRC, name)
        dst = os.path.join(OUT, out_name)
        build_one(src, dst)
        preview = dst.replace('.woff2', '-preview.woff2')
        build_preview(src, preview)
        print('%-24s %6.2fMB -> %5.2fMB  %s（预览 %.1fKB）' % (
            name, os.path.getsize(src) / 1048576, os.path.getsize(dst) / 1048576, out_name,
            os.path.getsize(preview) / 1024))
    write_coverage()
    return 0


if __name__ == '__main__':
    sys.exit(main())
