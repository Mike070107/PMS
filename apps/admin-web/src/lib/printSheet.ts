import sheetCss from '../pages/maintenance/maintenance-sheet.css?inline';

/**
 * 把一段已经渲染好的养护单 HTML 丢进隐藏 iframe 里打印。
 *
 * 为什么不用 window.print() + @media print（楼栋报修码那套）：
 * 那套靠全局 `@page { size: A5 }` 定纸张，而养护单是 227mm × 116mm，
 * 一个文档里两条 @page 只有一条生效 —— 谁后加载谁赢，另一个要么被裁要么多吐空白页。
 * iframe 是独立文档，各自的 @page 互不干扰，样式也只带这一份 CSS。
 */
export async function printMaintenanceSheets(html: string, title: string): Promise<void> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.title = title;
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    iframe.remove();
    throw new Error('浏览器不允许打开打印视图');
  }

  doc.open();
  doc.write(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<title>${escapeHtml(title)}</title><style>${sheetCss}</style></head>` +
      `<body class="mo-print-doc">${html}</body></html>`,
  );
  doc.close();

  // 签名是远程图片，没加载完就打印会印出空白格
  await waitForImages(doc);
  win.focus();
  win.print();
  // 打印对话框在 Chrome 里是同步阻塞的，Safari/部分环境不是 —— 留一段时间再拆
  window.setTimeout(() => iframe.remove(), 60_000);
}

function waitForImages(doc: Document): Promise<void> {
  const images = Array.from(doc.images);
  if (!images.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = images.length;
    // 图挂了也别卡住打印：最多等 5 秒
    const timer = window.setTimeout(resolve, 5000);
    const done = () => {
      left -= 1;
      if (left <= 0) {
        window.clearTimeout(timer);
        resolve();
      }
    };
    images.forEach((img) => {
      if (img.complete) return done();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
  );
}
