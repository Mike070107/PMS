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
  const numberLines = wrap(row.meterNo, 380, font(46, true));
  const nameLines = wrap(row.name || '未填写', 380, font(46, true));
  const addressLines = wrap(row.installAddress || '未填写', 840, font(38));
  const addressLabelY = 944 + Math.max(numberLines.length, nameLines.length) * 58 + 34;
  const addressY = addressLabelY + 42;
  const footerY = addressY + addressLines.length * 52 + 36;
  canvas.width = 960;
  canvas.height = footerY + 72;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 60, 24, 840, 840);
  context.textAlign = 'center'; context.textBaseline = 'top';
  context.font = font(28); context.fillStyle = '#536a72';
  context.fillText('表号', 270, 900); context.fillText('名称', 690, 900);
  context.font = font(46, true); context.fillStyle = '#152c34';
  numberLines.forEach((line, index) => context.fillText(line, 270, 944 + index * 58));
  nameLines.forEach((line, index) => context.fillText(line, 690, 944 + index * 58));
  context.strokeStyle = '#d6dfe2'; context.lineWidth = 2;
  context.beginPath(); context.moveTo(480, 904); context.lineTo(480, addressLabelY - 24); context.stroke();
  context.font = font(28); context.fillStyle = '#536a72'; context.fillText('安装地点', 480, addressLabelY);
  context.font = font(38); context.fillStyle = '#152c34';
  addressLines.forEach((line, index) => context.fillText(line, 480, addressY + index * 52));
  context.font = font(28); context.fillStyle = '#536a72';
  context.fillText(`${row.meterTypeLabel} · 设备码 ${row.shortCode}`, 480, footerY);
  return canvas.toDataURL('image/png');
}
