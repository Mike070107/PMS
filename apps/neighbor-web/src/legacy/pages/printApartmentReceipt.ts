const paperWidthMm = 80;
const maxLengthMm = 500;
const cooldownMs = 15_000;
const recentKey = 'pms.apartment-receipt.recent-prints';
let busy = false;

// Keep the measurement and print layout identical. The 72mm ink area is
// centered on an 80mm roll; no viewport heights, modal CSS or fixed footers.
const paperStyle = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 80mm; }
article { width: 72mm; margin: 0 auto; color: black; font: 14px/1.45 SimSun, "Microsoft YaHei", sans-serif; overflow-wrap: anywhere; }
h2, h3 { margin: 0; }
header, footer { text-align: center; }
header, .cashier-receipt__items, .cashier-receipt__total { border-bottom: 1px dashed; }
section, .cashier-receipt__total { padding: 1.5mm 0; }
section > div, .cashier-receipt__total { display: flex; justify-content: space-between; gap: 2mm; }
section > div > * { min-width: 0; }
section b { text-align: right; }
footer { border-top: 1px dashed; }
`;

async function printOnce(paper: HTMLElement, receiptNo: string) {
  const now = Date.now();
  const previous: {no: string; time: number}[] = JSON.parse(localStorage.getItem(recentKey) || '[]');
  const recent = previous.filter(job => now - job.time < cooldownMs);
  if (recent.some(job => job.no === receiptNo)) {
    throw new Error('刚已打开这张小票的打印窗口，请勿重复打印。需要补打时请等 15 秒。');
  }
  const frame = document.createElement('iframe');
  frame.title = '当前公寓小票';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:1px;border:0;pointer-events:none';
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    const target = frame.contentWindow;
    if (!doc || !target) throw new Error('无法创建小票打印窗口，请重新打开小票。');
    const style = doc.createElement('style');
    style.textContent = paperStyle;
    doc.head.append(style);
    doc.title = '公寓小票';
    const ticket = paper.cloneNode(true) as HTMLElement;
    doc.body.append(ticket);
    await doc.fonts.ready;
    if (!paper.isConnected) throw new Error('小票已关闭，请重新选择凭证。');
    const height = ticket.getBoundingClientRect().height;
    const mm = Math.ceil(height * 25.4 / 96) + 1;
    if (!Number.isFinite(mm) || height <= 0 || mm > maxLengthMm || ticket.scrollWidth > ticket.clientWidth + 1) {
      throw new Error('小票尺寸异常或超过 500 毫米，已拦截打印，请核对明细。');
    }
    style.append(`@page { size: ${paperWidthMm}mm ${mm}mm; margin: 0; }`);
    // Keep the frame and the lock until Chrome closes its print preview (including Cancel).
    await new Promise<void>((resolve, reject) => {
      target.addEventListener('afterprint', () => resolve(), {once:true});
      try {
        localStorage.setItem(recentKey, JSON.stringify([...recent, {no: receiptNo, time: Date.now()}]));
        target.print();
      } catch (error) { reject(error); }
    });
  } finally {
    frame.remove();
  }
}

export async function printApartmentReceipt(paper: HTMLElement | null, receiptNo: string | null, count: number) {
  if (!paper || !paper.matches('article.cashier-receipt') || !count) throw new Error('没有可打印的小票明细。');
  if (count > 40 || (paper.textContent?.length ?? 0) > 4000) {
    throw new Error('小票内容过长，已拦截打印。请核对明细和备注。');
  }
  if (busy) throw new Error('小票打印窗口已打开，请勿重复打印。');
  busy = true;
  try {
    const run = () => printOnce(paper, receiptNo || 'preview');
    if (navigator.locks) {
      await navigator.locks.request('pms-apartment-receipt-print', {ifAvailable:true}, lock => {
        if (!lock) throw new Error('其他页面正在打印小票，请勿重复打印。');
        return run();
      });
    } else await run();
  } finally {
    busy = false;
  }
}
