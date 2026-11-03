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
  const font = '38px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.font = font;
  const lines: string[] = [];
  for (const text of [`${row.meterTypeLabel} · 设备码 ${row.shortCode}`, `表号：${row.meterNo}`, `名称：${row.name || '未填写'}`, `安装地点：${row.installAddress || '未填写'}`]) {
    let line = '';
    for (const character of text.replace(/[\r\n\t]/g, ' ')) {
      if (line && context.measureText(line + character).width > 888) { lines.push(line); line = ''; }
      line += character;
    }
    if (line) lines.push(line);
  }
  canvas.width = 960;
  canvas.height = 910 + lines.length * 54 + 28;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 60, 24, 840, 840);
  context.font = font; context.fillStyle = '#152c34'; context.textBaseline = 'top';
  lines.forEach((line, index) => context.fillText(line, 36, 900 + index * 54));
  return canvas.toDataURL('image/png');
}
