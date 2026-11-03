/**
 * 布局自查：找出「字被挤到换行的控件」和「内容溢出盒子的元素」，标红并在控制台列出。
 * 开发环境自动开启；线上在地址后加 ?layoutcheck=1 开启（本标签页内保持）。
 */
const CONTROLS = '.btn, .chip, .pill, .tag, .seg button, .tabs button, .nav a, th';

/** 只看文字本身占了几行（图标、徽标的基线不同，不能算换行） */
function lineCount(el: Element): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const lines: Array<{ top: number; bottom: number }> = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of Array.from(range.getClientRects())) {
      if (!r.width || !r.height) continue;
      const mid = (r.top + r.bottom) / 2;
      if (!lines.some((l) => mid > l.top && mid < l.bottom)) lines.push({ top: r.top, bottom: r.bottom });
    }
  }
  return lines.length;
}

export interface LayoutIssue { kind: 'wrapped-control' | 'overflow' | 'squeezed-cell'; text: string; el: Element }

export function scanLayout(root: ParentNode = document): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  for (const el of Array.from(root.querySelectorAll(CONTROLS))) {
    const box = (el as HTMLElement).getBoundingClientRect();
    if (!box.width || !box.height) continue;
    if (lineCount(el) > 1) issues.push({ kind: 'wrapped-control', text: (el.textContent || '').trim().slice(0, 40), el });
  }
  // 表格列被挤到只剩两三个字宽、短值被拆成好几行（「5511弄/236号」竖排）
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('td, th'))) {
    const text = (el.textContent || '').trim();
    if (!text || !el.clientWidth) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize) || 14;
    const lines = lineCount(el);
    if (lines >= 2 && text.length <= 14 && el.clientWidth < fs * 6) issues.push({ kind: 'squeezed-cell', text: text.slice(0, 40), el });
  }
  // 整页出现横向滚动条
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    const wide = Array.from(document.querySelectorAll<HTMLElement>('table, pre, img')).find((e) => e.getBoundingClientRect().right > window.innerWidth + 2);
    issues.push({ kind: 'overflow', text: `整页横向溢出 ${document.documentElement.scrollWidth - window.innerWidth}px`, el: wide || document.body });
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('body *'))) {
    if (!el.clientWidth || el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' && cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue; // 本来就是滚动区
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
    if (!hasText) continue;
    if (cs.textOverflow === 'ellipsis') continue; // 有意省略
    issues.push({ kind: 'overflow', text: (el.textContent || '').trim().slice(0, 40), el });
  }
  return issues;
}

export function startLayoutGuard() {
  const q = new URLSearchParams(location.search);
  if (q.has('layoutcheck')) sessionStorage.setItem('pms.layoutcheck', q.get('layoutcheck') === '0' ? '' : '1');
  if (!import.meta.env.DEV && !sessionStorage.getItem('pms.layoutcheck')) return;
  const style = document.createElement('style');
  style.textContent = '[data-layout-issue]{outline:2px dashed #e5484d !important;outline-offset:1px}';
  document.head.appendChild(style);
  let last = '';
  const run = () => {
    document.querySelectorAll('[data-layout-issue]').forEach((e) => e.removeAttribute('data-layout-issue'));
    const issues = scanLayout();
    issues.forEach((i) => i.el.setAttribute('data-layout-issue', i.kind));
    const sig = issues.map((i) => i.kind + i.text).join('|');
    if (sig !== last) { last = sig; if (issues.length) console.warn('[layoutcheck]', issues.map((i) => `${i.kind}: ${i.text}`)); }
    (window as unknown as { __layoutIssues: unknown }).__layoutIssues = issues.map((i) => ({ kind: i.kind, text: i.text }));
  };
  window.setInterval(run, 1500);
}
