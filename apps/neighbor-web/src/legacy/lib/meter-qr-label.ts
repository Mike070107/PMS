export interface MeterQrLabel {
  dataUrl: string;
  meterNo: string;
  name: string;
  installAddress: string;
  meterTypeLabel: string;
  shortCode: string;
}

export function meterQrFilename(row: Pick<MeterQrLabel, 'meterNo' | 'meterTypeLabel' | 'shortCode'>) {
  return `表码-${row.meterTypeLabel}-${row.meterNo}-${row.shortCode}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.png';
}

/** Render the original QR untouched above a caption; captions never enter its quiet zone. */
export async function makeMeterQrLabel(row: MeterQrLabel): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.onload = null; img.onerror = null; reject(new Error('二维码图片加载超时，请重试')); }, 10000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('二维码图片读取失败，请重试')); };
    img.src = row.dataUrl;
  });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成表码标签');
  const font = (size: number, bold = false) => `${bold ? '600 ' : ''}${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  const wrap = (text: string, maxWidth: number, textFont: string) => {
    context.font = textFont;
    const lines: string[] = [];
    let line = '';
    for (const character of text.replace(/[\r\n\t]/g, ' ')) {
      if (line && context.measureText(line + character).width > maxWidth) { lines.push(line); line = ''; }
      line += character;
    }
    if (line) lines.push(line);
    return lines;
  };
  const numberLines = wrap(`表号：${row.meterNo}`, 330, font(34, true));
  const nameLines = wrap(`名称：${row.name || '未填写'}`, 330, font(34, true));
  const addressLines = wrap(`安装地点：${row.installAddress || '未填写'}`, 680, font(30));
  const addressY = 640 + Math.max(numberLines.length, nameLines.length) * 44 + 14;
  const footerY = addressY + addressLines.length * 38 + 16;
  canvas.width = 760;
  canvas.height = footerY + 48;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 80, 16, 600, 600);
  context.textAlign = 'center'; context.textBaseline = 'top';
  context.font = font(34, true); context.fillStyle = '#152c34';
  numberLines.forEach((line, index) => context.fillText(line, 205, 640 + index * 44));
  nameLines.forEach((line, index) => context.fillText(line, 555, 640 + index * 44));
  context.font = font(30);
  addressLines.forEach((line, index) => context.fillText(line, 380, addressY + index * 38));
  context.font = font(24); context.fillStyle = '#536a72';
  context.fillText(`${row.meterTypeLabel} · 设备码 ${row.shortCode}`, 380, footerY);
  return canvas.toDataURL('image/png');
}
