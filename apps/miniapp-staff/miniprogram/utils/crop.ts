export interface CropFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropTransform {
  scale: number;
  x: number;
  y: number;
  rotate: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 固定红框 → 原图归一化 ROI。
 *
 * 图片的 CSS 变换是 translate(x,y) scale(s) rotate(r)，原点在预览框中心。
 * 这里做逆变换，把固定框四角映射回图片坐标，再取轴对齐外接框。
 */
export function frameRoi(
  frame: CropFrame,
  transform: CropTransform,
  width: number,
  height: number,
): CropFrame {
  if (!width || !height) return { x: 0, y: 0, w: 1, h: 1 };
  const scale = clamp(Number(transform.scale) || 1, 0.2, 6);
  const rad = ((Number(transform.rotate) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tx = Number(transform.x) || 0;
  const ty = Number(transform.y) || 0;
  const points = [
    [frame.x, frame.y],
    [frame.x + frame.w, frame.y],
    [frame.x + frame.w, frame.y + frame.h],
    [frame.x, frame.y + frame.h],
  ].map(([fx, fy]) => {
    const dx = (fx * width - width / 2 - tx) / scale;
    const dy = (fy * height - height / 2 - ty) / scale;
    return {
      x: clamp((dx * cos + dy * sin + width / 2) / width, 0, 1),
      y: clamp((-dx * sin + dy * cos + height / 2) / height, 0, 1),
    };
  });
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = clamp(Math.min(...xs), 0, 0.99);
  const y = clamp(Math.min(...ys), 0, 0.99);
  return {
    x,
    y,
    w: clamp(Math.max(...xs) - x, 0.003, 1 - x),
    h: clamp(Math.max(...ys) - y, 0.003, 1 - y),
  };
}

/** 把一块检测到的 ROI 自动放进固定红框，返回图片变换。 */
export function fitRoiToFrame(
  frame: CropFrame,
  roi: CropFrame,
  width: number,
  height: number,
): CropTransform {
  if (!width || !height || roi.w <= 0 || roi.h <= 0) {
    return { scale: 1, x: 0, y: 0, rotate: 0 };
  }
  const scale = clamp(Math.min(frame.w / roi.w, frame.h / roi.h), 0.6, 5);
  return {
    scale,
    x: (frame.x + frame.w / 2 - 0.5) * width - (roi.x + roi.w / 2 - 0.5) * width * scale,
    y: (frame.y + frame.h / 2 - 0.5) * height - (roi.y + roi.h / 2 - 0.5) * height * scale,
    rotate: 0,
  };
}
