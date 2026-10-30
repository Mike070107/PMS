/** 使用挂载的 2D canvas 导出红框识别图；原始路径始终只读。 */
export async function renderMeterCrop(
  page: any, photoPath: string,
  plan: { width: number; height: number; centerX: number; centerY: number;
    drawWidth: number; drawHeight: number; scale: number; radians: number },
  isCurrent: () => boolean = () => true,
): Promise<string> {
  const canvas: any = await new Promise((resolve, reject) => {
    page.createSelectorQuery().select('#meter-recognition-canvas').fields({ node: true }).exec((rows: any[]) => {
      const node = rows?.[0]?.node;
      if (node) resolve(node);
      else reject(new Error('裁切画布尚未就绪，请稍后重试'));
    });
  });
  canvas.width = plan.width;
  canvas.height = plan.height;
  const picture = canvas.createImage();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('原图加载超时，请重试')), 15000);
    picture.onload = () => { clearTimeout(timer); resolve(); };
    picture.onerror = () => { clearTimeout(timer); reject(new Error('原图无法读取，请重新选择照片')); };
    picture.src = photoPath;
  });
  if (!isCurrent()) throw new Error('本次裁切已取消');
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, plan.width, plan.height);
  context.translate(plan.centerX, plan.centerY);
  context.scale(plan.scale, plan.scale);
  context.rotate(plan.radians);
  context.drawImage(picture, -plan.drawWidth / 2, -plan.drawHeight / 2, plan.drawWidth, plan.drawHeight);
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width: plan.width, height: plan.height,
    destWidth: plan.width, destHeight: plan.height, fileType: 'png',
    success: (result) => resolve(result.tempFilePath),
    fail: () => reject(new Error('裁切图生成失败，原图仍保留，可重试或手工输入')),
  }, page));
}
